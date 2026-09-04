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

export const DEFAULT_DB = path.join(os.homedir(),
  'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');

const NL = "length(x) - length(replace(x, char(10), ''))";   // line count, in SQL

function query(db, sql) {
  // immutable=1 so a running Cursor is never locked or written to.
  const out = execFileSync('sqlite3', [`file:${db}?mode=ro&immutable=1`, sql],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
  return out.split('\n').filter(Boolean).map((r) => r.split('|'));
}

const J = (p) => `json_extract(value,'$.${p}')`;
// rawArgs is not always valid JSON — a streamed edit can be cut off mid-write, and
// json_extract aborts the entire query on the first malformed row. Guard every read.
const RAW = J('toolFormerData.rawArgs');
const ARG = (k) => `(CASE WHEN json_valid(${RAW}) THEN json_extract(${RAW},'$.${k}') END)`;

// One grouped pass over the whole table. Per-conversation `LIKE 'bubbleId:<id>:%'`
// queries are each a full scan of a multi-GB table, and six of them per session
// times out; this scans once and returns every conversation at once.
// Which model drove each conversation. Most bubbles record "default", so only the
// named ones count — about a sixth of conversations end up with real gear.
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
           sum(${J('toolFormerData.status')}='error'),
           sum(${J('toolFormerData.userDecision')}='accepted'),
           sum(${J('toolFormerData.userDecision')}='rejected'),
           coalesce(sum(${J('tokenCount.inputTokens')}),0) + coalesce(sum(${J('tokenCount.outputTokens')}),0),
           min(${J('createdAt')}), max(${J('createdAt')}),
           min(CASE WHEN ${J('type')}=1 AND length(${J('text')})>0
                    THEN ${J('createdAt')} || char(31) || replace(substr(${J('text')},1,200), char(10), ' ') END)
    FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' GROUP BY c;`);

  const out = new Map();
  for (const [c, bubbles, tools, errors, acc, rej, tok, first, last, firstPrompt] of rows) {
    out.set(c, {
      id: c, bubbles: +bubbles, toolCalls: +tools, errors: +errors,
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
      FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND ${RAW} IS NOT NULL;`)) {
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
  const diffs = scanDiffs(db);
  const files = scanFiles(db);
  const times = scanTimes(db);

  const out = new Map();
  for (const [id, b] of bubbles) {
    const ts = times.get(id) || [];
    let moving = 0;
    for (let i = 1; i < ts.length; i++) moving += Math.min(ts[i] - ts[i - 1], 300_000);
    const d = diffs.get(id) || { added: 0, removed: 0 };
    b.model = dominantModel(models.get(id) || {});
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
