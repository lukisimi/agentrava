// Codex CLI support. Codex writes one rollout JSONL per session under
// ~/.codex/sessions/YYYY/MM/DD/, with a timestamp on every line.
//
// It records more than the other two clients: file changes arrive as explicit
// FileChange items — a full body for an added file, a unified diff for an edited
// one — so churn is exact rather than inferred from shell commands (Claude Code)
// or unavailable (Cursor).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { creditInterval, roundDaily } from './periods.js';
import { dominantModel } from './models.js';
import { buildProfile } from './session.js';

export const SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const GAP_CAP_MS = 300_000;

// Every tool invocation reaches the log as one of these three response_item
// shapes: shell runs and web search as custom_tool_call, MCP servers and the
// built-ins as function_call, tool discovery as tool_search_call. The parallel
// `item_completed` stream describes the same calls in nicer prose
// (CommandExecution, McpToolCall, WebSearch), so counting both would double.
const TOOL_CALL = new Set(['custom_tool_call', 'function_call', 'tool_search_call']);

// Codex opens a session by feeding itself context as user messages: the
// environment block, AGENTS.md, the plugin list, a replayed approval history.
// Taking the first user message verbatim titled sessions "<recommended_plugins>".
const INJECTED = /^(<[a-z_]+>|#\s|The following is the Codex agent history\b)/;
const isInjected = (t) => INJECTED.test(t);

export function findRollouts(dir = SESSIONS_DIR, out = [], depth = 0) {
  if (depth > 5) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findRollouts(full, out, depth + 1);
    else if (/^rollout-.*\.jsonl$/.test(e.name)) {
      try {
        const st = fs.statSync(full);
        // rollout-<ISO timestamp>-<uuid>.jsonl — the uuid is the session id.
        const id = (e.name.match(/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/) || [])[1]
          || e.name.replace(/^rollout-|\.jsonl$/g, '');
        out.push({ id, file: full, mtime: st.mtimeMs, size: st.size });
      } catch { /* vanished mid-scan */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

const countDiff = (diff) => {
  let added = 0, removed = 0;
  for (const line of String(diff).split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
};

export async function parseCodexSession(file) {
  const s = {
    toolCalls: 0, errors: 0, files: new Set(), added: 0, removed: 0,
    tokens: 0, tokIn: 0, tokOut: 0, tokCacheWrite: 0, tokCacheRead: 0, costUsd: 0,
    first: null, last: null, moving: 0, daily: {}, prompt: '', cwd: '',
    models: {}, events: [], shellFiles: new Set(),
  };
  let prevTs = null, atMoving = 0, usage = null;

  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }

    const ts = d.timestamp ? Date.parse(d.timestamp) : NaN;
    if (!Number.isNaN(ts)) {
      if (s.first === null || ts < s.first) s.first = ts;
      if (s.last === null || ts > s.last) s.last = ts;
      if (prevTs !== null && ts > prevTs) {
        const credit = Math.min(ts - prevTs, GAP_CAP_MS);
        s.moving += credit;
        creditInterval(s.daily, ts - credit, ts);
      }
      prevTs = ts;
      atMoving = s.moving;
    }

    const p = d.payload || {};
    if (d.type === 'session_meta' && p.cwd && !s.cwd) s.cwd = p.cwd;
    if (d.type === 'turn_context') {
      if (p.model) s.models[p.model] = (s.models[p.model] || 0) + 1;
      if (p.cwd && !s.cwd) s.cwd = p.cwd;
    }

    if (d.type === 'response_item') {
      if (TOOL_CALL.has(p.type)) s.toolCalls++;
      if (p.type === 'message' && p.role === 'user' && !s.prompt) {
        const c = Array.isArray(p.content) ? p.content : [];
        const t = c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join(' ').trim();
        if (t && !isInjected(t)) s.prompt = t;
      }
      continue;
    }

    if (d.type !== 'event_msg') continue;

    // Cumulative, so the last one wins rather than being summed.
    if (p.type === 'token_count' && p.info && p.info.total_token_usage) usage = p.info.total_token_usage;

    if (p.type !== 'item_completed') continue;
    const item = p.item || {};
    if (item.status === 'failed') {
      s.errors++;
      s.events.push({ at: atMoving, gain: 120 });
    }
    if (item.type !== 'FileChange') continue;
    for (const [file_, change] of Object.entries(item.changes || {})) {
      if (!s.files.has(file_)) { s.files.add(file_); s.events.push({ at: atMoving, gain: 37 }); }
      if (!change || typeof change !== 'object') continue;
      if (change.type === 'add' && typeof change.content === 'string') {
        s.added += change.content.split('\n').length;
      } else if (typeof change.unified_diff === 'string') {
        const { added, removed } = countDiff(change.unified_diff);
        s.added += added;
        s.removed += removed;
      }
    }
  }

  if (usage) {
    // input_tokens includes the cached portion; split it out so the token total
    // means the same thing it does for the other clients.
    s.tokCacheRead = usage.cached_input_tokens || 0;
    s.tokIn = Math.max(0, (usage.input_tokens || 0) - s.tokCacheRead);
    s.tokCacheWrite = usage.cache_write_input_tokens || 0;
    s.tokOut = usage.output_tokens || 0;
    s.tokens = s.tokIn + s.tokCacheWrite + s.tokOut;
  }
  // Cost is left unset: OpenAI list prices are not bundled, and inventing them
  // would put a fabricated number next to measured ones.
  s.model = dominantModel(s.models);
  s.profile = buildProfile(s.events, s.moving);
  s.daily = s.daily;
  return s;
}
