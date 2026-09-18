// Cursor support. Cursor stores chat in SQLite rather than JSONL: one row per
// message "bubble", keyed bubbleId:<conversationId>:<bubbleId>, so a session is
// selected directly by the conversation_id its stop hook hands us.
//
// Everything is aggregated in SQL — the edit payloads hold whole file bodies, and
// there are 15k of them, so line counts are computed with replace() rather than
// shipped through the pipe.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { dominantModel } from './models.js';
import { buildProfile } from './session.js';
import { creditInterval, roundDaily } from './periods.js';
import { sqlEnvironmental } from './errors.js';

export const DEFAULT_DB = path.join(os.homedir(),
  'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');

const NL = "length(x) - length(replace(x, char(10), ''))";   // line count, in SQL

// Cursor's database is WAL-mode and usually has megabytes of uncommitted log
// while the app runs. immutable=1 makes SQLite ignore the WAL entirely, which
// hides the newest conversations — the very ones worth snapshotting — and throws
// "malformed" when a checkpoint lands mid-read. mode=ro respects the WAL, and if
// the live read still fails we snapshot the file set and read that instead.
function run(target, sql) {
  return execFileSync('sqlite3', [target, sql],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
}

let snapshotDir = null;
function snapshotOf(db) {
  if (snapshotDir) return path.join(snapshotDir, 'state.vscdb');
  snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrava-cursor-'));
  for (const suffix of ['', '-wal', '-shm']) {
    const src = db + suffix;
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(snapshotDir, 'state.vscdb' + suffix));
  }
  process.once('exit', () => { try { fs.rmSync(snapshotDir, { recursive: true, force: true }); } catch {} });
  return path.join(snapshotDir, 'state.vscdb');
}

function query(db, sql) {
  let out;
  try {
    out = run(`file:${db}?mode=ro`, sql);
  } catch (err) {
    const msg = String(err.stderr || err.message || '');
    if (!/malformed|locked|busy|disk image/i.test(msg)) throw err;
    // Copy the db plus its -wal and -shm so the snapshot is internally consistent.
    out = run(`file:${snapshotOf(db)}?mode=ro`, sql);
  }
  return out.split('\n').filter(Boolean).map((r) => r.split('|'));
}

const J = (p) => `json_extract(value,'$.${p}')`;
// Cursor puts the failure text here; errors.js decides which failures are the
// environment rather than the agent, and those are kept out of the climb.
const ERR_TEXT = J('toolFormerData.result');
const ENV_ERR = sqlEnvironmental(ERR_TEXT);
// rawArgs is not always valid JSON — a streamed edit can be cut off mid-write, and
// json_extract aborts the entire query on the first malformed row. Guard every read.
const RAW = J('toolFormerData.rawArgs');
// Only these actually change a file. Counting every tool that carries a path
// credited reads as edits, which inflated files_changed and so elevation.
const EDIT_TOOLS = ['edit_file_v2', 'search_replace', 'write', 'apply_patch',
                    'create_file', 'MultiEdit', 'str_replace_editor'];
const IS_EDIT = `${J('toolFormerData.name')} IN (${EDIT_TOOLS.map((t) => `'${t}'`).join(',')})`;
const ARG = (k) => `(CASE WHEN json_valid(${RAW}) THEN json_extract(${RAW},'$.${k}') END)`;

// One grouped pass over the whole table. Per-conversation `LIKE 'bubbleId:<id>:%'`
// queries are each a full scan of a multi-GB table, and six of them per session
// times out; this scans once and returns every conversation at once.
// Which model drove each conversation. Most bubbles record "default", so only the
// named ones count — about a sixth of conversations end up with real gear.
// Where the climbing happened, for the elevation profile. Cursor has no
// per-file first-touch signal in one pass, so an edit call stands in for a file
// touched; errors carry the same weight as elsewhere.
function scanClimb(db) {
  const out = new Map();
  for (const [c, at, err, edit] of query(db, `
    SELECT substr(key,10,36) c, ${J('createdAt')},
           ${J('toolFormerData.status')}='error' AND NOT ${ENV_ERR},
           ${IS_EDIT}
    FROM cursorDiskKV
    WHERE key LIKE 'bubbleId:%' AND ${J('toolFormerData.name')} IS NOT NULL
      AND ${J('createdAt')} IS NOT NULL;`)) {
    const gain = (err === '1' ? 120 : 0) + (edit === '1' ? 37 : 0);
    if (!gain) continue;
    if (!out.has(c)) out.set(c, []);
    out.get(c).push({ t: Date.parse(at), gain });
  }
  return out;
}

function scanModels(db) {
  const out = new Map();
  for (const [c, m, n] of query(db, `
    SELECT substr(key,10,36) c, ${J('modelInfo.modelName')} m, count(*)
    FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND m IS NOT NULL
    GROUP BY c, m;`)) {
    if (!out.has(c)) out.set(c, {});
    out.get(c)[m] = Number(n) || 0;
  }
  return out;
}

function scanBubbles(db) {
  const rows = query(db, `
    SELECT substr(key,10,36) c,
           count(*),
           sum(${J('toolFormerData.name')} IS NOT NULL),
           sum(${J('toolFormerData.status')}='error' AND NOT ${ENV_ERR}),
           sum(${J('toolFormerData.status')}='error' AND ${ENV_ERR}),
           sum(${J('toolFormerData.userDecision')}='accepted'),
           sum(${J('toolFormerData.userDecision')}='rejected'),
           coalesce(sum(${J('tokenCount.inputTokens')}),0) + coalesce(sum(${J('tokenCount.outputTokens')}),0),
           min(${J('createdAt')}), max(${J('createdAt')}),
           min(CASE WHEN ${J('type')}=1 AND length(${J('text')})>0
                    THEN ${J('createdAt')} || char(31) || replace(substr(${J('text')},1,200), char(10), ' ') END)
    FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' GROUP BY c;`);

  const out = new Map();
  for (const [c, bubbles, tools, errors, envErrors, acc, rej, tok, first, last, firstPrompt] of rows) {
    out.set(c, {
      id: c, bubbles: +bubbles, toolCalls: +tools, errors: +errors, envErrors: +envErrors,
      accepted: +acc, rejected: +rej, tokens: +tok,
      first: Date.parse(first) || null, last: Date.parse(last) || null,
      firstAt: first, lastAt: last,
      prompt: (firstPrompt || '').split('\u001f')[1] || '',
    });
  }
  return out;
}

// Churn lives in codeBlockDiff:<conversation>:<bubble>, not in the tool args —
// rawArgs carries an edit body for only ~1.5% of calls.
function scanDiffs(db) {
  const out = new Map();
  for (const [c, raw] of query(db, `
      SELECT substr(key,15,36), replace(value, char(10), ' ')
      FROM cursorDiskKV WHERE key LIKE 'codeBlockDiff:%';`)) {
    const e = out.get(c) || { added: 0, removed: 0 };
    try {
      for (const h of JSON.parse(raw).newModelDiffWrtV0 || []) {
        e.added += (h.modified || []).length;
        const o = h.original || {};
        e.removed += Math.max(0, (o.endLineNumberExclusive || 0) - (o.startLineNumber || 0));
      }
    } catch { /* partial row */ }
    out.set(c, e);
  }
  return out;
}

// Files touched, grouped in the same single-scan style.
function scanFiles(db) {
  const out = new Map();
  for (const [c, p] of query(db, `
      SELECT DISTINCT substr(key,10,36), coalesce(${ARG('path')}, ${ARG('file_path')})
      FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND ${RAW} IS NOT NULL AND ${IS_EDIT};`)) {
    if (!p || !p.startsWith('/')) continue;
    if (!out.has(c)) out.set(c, new Set());
    out.get(c).add(p);
  }
  return out;
}

// Moving time needs per-bubble gaps, so timestamps come back ungrouped — still
// one scan, and only two small columns.
function scanTimes(db) {
  const out = new Map();
  for (const [c, t] of query(db, `
      SELECT substr(key,10,36), ${J('createdAt')} FROM cursorDiskKV
      WHERE key LIKE 'bubbleId:%' AND ${J('createdAt')} IS NOT NULL;`)) {
    const ms = Date.parse(t);
    if (Number.isNaN(ms)) continue;
    if (!out.has(c)) out.set(c, []);
    out.get(c).push(ms);
  }
  for (const arr of out.values()) arr.sort((a, b) => a - b);
  return out;
}

// Read the whole database once and return a stats object per conversation,
// shaped exactly like the Claude Code transcript parser's output.
export function scanCursorDb(db = DEFAULT_DB) {
  if (!fs.existsSync(db)) throw new Error(`no Cursor database at ${db}`);
  const bubbles = scanBubbles(db);
  const models = scanModels(db);
  const climbs = scanClimb(db);
  const diffs = scanDiffs(db);
  const files = scanFiles(db);
  const times = scanTimes(db);

  const out = new Map();
  for (const [id, b] of bubbles) {
    const ts = times.get(id) || [];
    let moving = 0;
    const daily = {};
    for (let i = 1; i < ts.length; i++) {
      const credit = Math.min(ts[i] - ts[i - 1], 300_000);
      moving += credit;
      creditInterval(daily, ts[i] - credit, ts[i]);
    }
    b.daily = daily;          // raw ms; storeSession converts once, like every other parser
    const d = diffs.get(id) || { added: 0, removed: 0 };
    b.model = dominantModel(models.get(id) || {});
    // Position each climb event by moving time, matching the Claude Code path.
    const raw = (climbs.get(id) || []).filter((e) => !Number.isNaN(e.t)).sort((x, y) => x.t - y.t);
    if (raw.length >= 3 && ts.length) {
      let acc = 0, prev = null, k = 0;
      const events = [];
      for (const t of ts) {
        if (prev !== null && t > prev) acc += Math.min(t - prev, 300_000);
        prev = t;
        while (k < raw.length && raw[k].t <= t) { events.push({ at: acc, gain: raw[k].gain }); k++; }
      }
      b.profile = buildProfile(events, acc);
    }
    out.set(id, {
      ...b, moving,
      files: files.get(id) || new Set(),
      added: d.added, removed: d.removed,
      shellFiles: new Set(), cwd: '',
    });
  }
  return out;
}

export function listConversations(db = DEFAULT_DB) {
  return [...scanCursorDb(db).values()].sort((a, b) => (b.last || 0) - (a.last || 0));
}

export function parseCursorSession(conversationId, db = DEFAULT_DB) {
  const s = scanCursorDb(db).get(conversationId);
  if (!s) throw new Error('conversation not found');
  return s;
}

// Which project did this session mostly work in? The common prefix of every
// touched path collapses to $HOME as soon as a thread spans two projects, so
// count files per project root and take the winner.
export function inferRepo(files, home = os.homedir()) {
  const counts = new Map();
  for (const f of files) {
    if (!f.startsWith(home + path.sep)) continue;
    const rel = f.slice(home.length + 1).split(path.sep);
    const top = rel[0];
    if (!top || top.startsWith('.')) continue;        // dotfiles are not projects
    const root = path.join(home, top);
    counts.set(root, (counts.get(root) || 0) + 1);
  }
  let best = null, n = 0;
  for (const [root, c] of counts) if (c > n) { best = root; n = c; }
  return best;
}
