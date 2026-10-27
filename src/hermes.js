// Hermes Agent support (Nous Research). Hermes keeps every session — CLI, TUI,
// Desktop and the messaging gateway (Telegram, Discord, Slack, …) alike — in one
// SQLite database per profile: ~/.hermes/state.db, plus
// ~/.hermes/profiles/<name>/state.db for each extra profile.
//
// All of them are logged. People drive Hermes from a chat app as much as from a
// terminal, and the tool-call floor in storeSession already keeps a chat about
// dinner off the board.
//
// A conversation is not always one row. Subagents, /branch and non-in-place
// compaction each continue it under a new session id linked by
// parent_session_id, and Hermes itself treats the chain as one conversation, so
// it is logged as one: under the id of the session at the top.
//
// Written against the published schema (sessions, messages) rather than an
// observed database; columns beyond the documented ones are probed, never assumed.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { dominantModel } from './models.js';
import { costOf } from './pricing.js';
import { isEnvironmentError } from './errors.js';
import { buildProfile } from './session.js';
import { creditInterval } from './periods.js';

const GAP_CAP_MS = 300_000;

export const HERMES_HOME = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');

// Every profile's database, the default profile first.
export function findDatabases(home = HERMES_HOME) {
  const out = [];
  const main = path.join(home, 'state.db');
  if (fs.existsSync(main)) out.push(main);
  let entries = [];
  try { entries = fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true }); } catch { /* none */ }
  for (const e of entries) {
    const db = path.join(home, 'profiles', e.name, 'state.db');
    if (e.isDirectory() && fs.existsSync(db)) out.push(db);
  }
  return out;
}

// The gateway holds the database open in WAL mode, so read through the WAL
// (mode=ro), and fall back to a snapshot of the file set if a checkpoint lands
// mid-read — the same approach as the Cursor reader.
const snapshots = new Map();
function snapshotOf(db) {
  if (snapshots.has(db)) return snapshots.get(db);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrava-hermes-'));
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(db + suffix)) fs.copyFileSync(db + suffix, path.join(dir, 'state.db' + suffix));
  }
  process.once('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const copy = path.join(dir, 'state.db');
  snapshots.set(db, copy);
  return copy;
}

// -json, not the pipe-separated default: message content is free text and
// would split on any '|' in it.
function query(db, sql) {
  const run = (target) => execFileSync('sqlite3', ['-json', target, sql],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 60000 });
  let out;
  try {
    out = run(`file:${db}?mode=ro`);
  } catch (err) {
    const msg = String(err.stderr || err.message || '');
    if (!/malformed|locked|busy|disk image/i.test(msg)) throw err;
    out = run(`file:${snapshotOf(db)}?mode=ro`);
  }
  return out.trim() ? JSON.parse(out) : [];
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const columnCache = new Map();
function columns(db, table) {
  const key = `${db}:${table}`;
  if (!columnCache.has(key)) columnCache.set(key, new Set(query(db, `PRAGMA table_info(${table});`).map((r) => r.name)));
  return columnCache.get(key);
}

// The session at the top of a lineage chain, and every session below it.
function family(db, id) {
  const [top] = query(db, `
    WITH RECURSIVE up(id, p) AS (
      SELECT id, parent_session_id FROM sessions WHERE id = ${q(id)}
      UNION ALL SELECT s.id, s.parent_session_id FROM sessions s JOIN up ON s.id = up.p)
    SELECT id FROM up WHERE p IS NULL OR p NOT IN (SELECT id FROM sessions) LIMIT 1;`);
  if (!top) return null;
  const ids = query(db, `
    WITH RECURSIVE d(id) AS (
      SELECT ${q(top.id)}
      UNION SELECT s.id FROM sessions s JOIN d ON s.parent_session_id = d.id)
    SELECT id FROM d;`).map((r) => r.id);
  return { root: top.id, ids };
}

// Only these change a file. read_file and search_files carry a path too, and
// counting them inflated files_changed — and so elevation — for Cursor.
const EDIT_TOOLS = new Set(['write_file', 'patch']);

// A file body ends in a newline; that is not another line.
const lineCount = (t) => (typeof t === 'string' && t.length ? t.replace(/\n$/, '').split('\n').length : 0);

// Hermes names models the OpenRouter way, vendor first (anthropic/claude-sonnet-4.5);
// the naming and pricing tables key on the bare model.
const bare = (m) => String(m || '').split('/').pop();

// A patch either replaces old_string with new_string, or carries a whole
// V4A/unified patch in `patch`.
function patchChurn(args) {
  if (typeof args.patch === 'string') {
    let added = 0, removed = 0;
    for (const line of args.patch.split('\n')) {
      if (/^(\+\+\+|---|@@|\*\*\*)/.test(line)) continue;
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
    return { added, removed };
  }
  return { added: lineCount(args.new_string), removed: lineCount(args.old_string) };
}

const parseArgs = (raw) => {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || '{}') || {}; } catch { return {}; }
};

function emptyStats() {
  return {
    toolCalls: 0, errors: 0, envErrors: 0, files: new Set(), added: 0, removed: 0,
    tokens: 0, tokIn: 0, tokOut: 0, tokCacheWrite: 0, tokCacheRead: 0, costUsd: 0,
    first: null, last: null, moving: 0, daily: {}, prompt: '', cwd: '',
    models: {}, events: [], shellFiles: new Set(), source: '',
  };
}

// Stats for one conversation, shaped like every other parser's output. `id` may
// be any session in the chain; the result's `id` is the one at the top.
export function parseHermesSession(id, db) {
  const dbs = db ? [db] : findDatabases();
  for (const d of dbs) {
    const fam = family(d, id);
    if (fam) return { id: fam.root, db: d, ...scanFamily(d, fam.ids) };
  }
  throw new Error(`no Hermes session ${id}`);
}

function scanFamily(db, ids) {
  const s = emptyStats();
  const inIds = `(${ids.map(q).join(',')})`;
  const scols = columns(db, 'sessions');
  const mcols = columns(db, 'messages');

  // Tokens and cost are kept per session row by Hermes itself; sum the chain.
  const pick = ['id', 'source', 'model', 'started_at', 'ended_at', 'input_tokens', 'output_tokens',
    'cache_read_tokens', 'cache_write_tokens', 'estimated_cost_usd', 'actual_cost_usd',
    'cwd', 'workspace', 'workspace_path', 'working_dir'].filter((c) => scols.has(c));
  const rows = query(db, `SELECT ${pick.join(',')} FROM sessions WHERE id IN ${inIds} ORDER BY started_at;`);
  let priced = true;
  for (const r of rows) {
    s.tokIn += r.input_tokens || 0;
    s.tokOut += r.output_tokens || 0;
    s.tokCacheRead += r.cache_read_tokens || 0;
    s.tokCacheWrite += r.cache_write_tokens || 0;
    // Hermes prices every request at the provider it actually went to, which
    // beats re-pricing a total here. A row it could not price is priced from
    // the list rates instead, or left at zero for an unknown model.
    const known = r.actual_cost_usd ?? r.estimated_cost_usd;
    if (known != null) s.costUsd += known;
    else {
      priced = false;
      s.costUsd += costOf({ model: bare(r.model), input: r.input_tokens || 0, output: r.output_tokens || 0,
        cacheRead: r.cache_read_tokens || 0, cacheWrite: r.cache_write_tokens || 0 }) || 0;
    }
    if (!s.source && r.source) s.source = r.source;
    if (!s.cwd) s.cwd = r.cwd || r.workspace || r.workspace_path || r.working_dir || '';
  }
  s.tokens = s.tokIn + s.tokCacheWrite + s.tokOut;
  s.costEstimated = !priced;

  // A /branch copies its history into the new row; message_uid, where the
  // schema has it, is what keeps those copies from counting twice.
  const uid = mcols.has('message_uid') ? 'message_uid' : 'NULL';
  const msgs = query(db, `
    SELECT role, tool_calls, tool_name, timestamp,
           CASE WHEN role = 'user' THEN substr(content, 1, 400) END AS prompt,
           CASE WHEN role = 'tool' AND json_valid(content) THEN
             (json_extract(content, '$.error') IS NOT NULL
              OR json_extract(content, '$.success') = 0
              OR json_extract(content, '$.ok') = 0
              OR coalesce(json_extract(content, '$.exit_code'), 0) <> 0)
           ELSE 0 END AS failed,
           CASE WHEN role = 'tool' THEN substr(coalesce(
             CASE WHEN json_valid(content) THEN json_extract(content, '$.error') END, content), 1, 300) END AS err
    FROM messages WHERE session_id IN ${inIds}
    GROUP BY coalesce(${uid}, id)
    ORDER BY timestamp, id;`);

  const models = {};
  for (const r of rows) if (r.model) models[bare(r.model)] = 0;
  let prevTs = null;
  for (const m of msgs) {
    const ts = Math.round(Number(m.timestamp) * 1000);
    if (Number.isFinite(ts) && ts > 0) {
      if (s.first === null || ts < s.first) s.first = ts;
      if (s.last === null || ts > s.last) s.last = ts;
      if (prevTs !== null && ts > prevTs) {
        const credit = Math.min(ts - prevTs, GAP_CAP_MS);
        s.moving += credit;
        creditInterval(s.daily, ts - credit, ts);
      }
      prevTs = ts;
    }

    if (m.role === 'user' && !s.prompt && m.prompt && m.prompt.trim()) s.prompt = m.prompt.trim();

    if (m.role === 'assistant' && m.tool_calls) {
      let calls = [];
      try { calls = JSON.parse(m.tool_calls) || []; } catch { /* partial row */ }
      for (const c of Array.isArray(calls) ? calls : []) {
        s.toolCalls++;
        const fn = c.function || c;
        if (!EDIT_TOOLS.has(fn.name)) continue;
        const args = parseArgs(fn.arguments);
        const file = args.path || args.file_path;
        if (typeof file === 'string' && file && !s.files.has(file)) {
          s.files.add(file);
          s.events.push({ at: s.moving, gain: 37 });
        }
        const { added, removed } = fn.name === 'write_file'
          ? { added: lineCount(args.content), removed: 0 }
          : patchChurn(args);
        s.added += added;
        s.removed += removed;
      }
    }

    if (m.role === 'tool' && m.failed) {
      if (isEnvironmentError(m.err)) s.envErrors++;
      else {
        s.errors++;
        s.events.push({ at: s.moving, gain: 120 });
      }
    }
  }

  // The sessions table records one model per row, so the gear is whichever
  // model ran the most rows of the chain.
  for (const r of rows) if (r.model) models[bare(r.model)] += 1;
  if (Object.keys(models).length) s.models = models;
  s.model = dominantModel(models) || '';
  s.profile = buildProfile(s.events, s.moving);
  return s;
}

// Top-of-chain sessions, newest first, across every profile.
export function listHermesSessions() {
  const out = [];
  for (const db of findDatabases()) {
    let rows = [];
    try {
      rows = query(db, `
        SELECT s.id, s.source, s.started_at, s.title,
               (SELECT max(timestamp) FROM messages m WHERE m.session_id = s.id) AS last
        FROM sessions s
        WHERE s.parent_session_id IS NULL OR s.parent_session_id NOT IN (SELECT id FROM sessions)
        ORDER BY coalesce(last, s.started_at) DESC;`);
    } catch { continue; }
    for (const r of rows) out.push({ id: r.id, db, source: r.source, title: r.title,
      mtime: Math.round((r.last || r.started_at || 0) * 1000) });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
