// Shared session parser: turns a Claude Code transcript into a logged activity.
// Used by the Stop hook (one session, live) and by the backfill (all of them).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';

import { upsertBySession, all, config } from './store.js';
import { clean } from './metrics.js';
import { dominantModel } from './models.js';
import { badgesFor, prsFor, streak } from './achievements.js';
import { renderCard } from './card.js';
import { writeCard } from './render.js';

const MIN_TOOL_CALLS = 8;      // below this it was a conversation, not a session
const MIN_SECONDS = 120;
const MAX_TRANSCRIPT_BYTES = 300 * 1024 * 1024;

const EXT_LANG = {
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript',
  ts: 'TypeScript', tsx: 'TypeScript', py: 'Python', rb: 'Ruby', go: 'Go',
  rs: 'Rust', java: 'Java', kt: 'Kotlin', swift: 'Swift', c: 'C', h: 'C',
  cc: 'C++', cpp: 'C++', hpp: 'C++', cs: 'C#', php: 'PHP', sh: 'Shell',
  bash: 'Shell', zsh: 'Shell', sql: 'SQL', html: 'HTML', css: 'CSS',
  scss: 'CSS', json: 'JSON', yml: 'YAML', yaml: 'YAML', md: 'Markdown',
  toml: 'TOML', vue: 'Vue', svelte: 'Svelte', ex: 'Elixir', erl: 'Erlang',
  scala: 'Scala', dart: 'Dart', lua: 'Lua', r: 'R', pl: 'Perl',
};

// Files written through Bash (cat > f <<EOF, tee, sed -i) leave no structured
// diff, so a session that builds real files this way looks like it touched
// nothing. Recover the paths from the command text; conservative on purpose —
// a missed write is better than a phantom one.
const REDIRECT = /(?:^|[|;&\n]|&&)\s*[^|;&\n]*?[^0-9&\s]\s*>>?\s*(?!&)("[^"]+"|'[^']+'|[^\s|;&<>()]+)/g;
const TEE = /\btee\s+(?:-a\s+)?("[^"]+"|'[^']+'|[^\s|;&<>()-][^\s|;&<>()]*)/g;
const SED_I = /\bsed\s+(?:-[a-zA-Z]*i[a-zA-Z]*\b[^|;&\n]*?)\s("[^"]+"|'[^']+'|[^\s|;&<>()]+)\s*$/gm;

// A heredoc body is data, not shell: scanning it counts every ">" in generated
// HTML as a redirect. Strip the bodies, keep the delimiter line that names the file.
function stripHeredocs(cmd) {
  return cmd.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?^\s*\2\s*$/gm,
                     (m) => m.split('\n')[0]);
}

function bashWrites(cmd) {
  if (typeof cmd !== 'string' || cmd.length > 20000) return [];
  cmd = stripHeredocs(cmd);
  const out = [];
  for (const re of [REDIRECT, TEE, SED_I]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(cmd))) {
      const p = m[1].replace(/^['"]|['"]$/g, '');
      if (!p || p.startsWith('/dev/') || p.startsWith('&') || /^\d+$/.test(p)) continue;
      if (p.includes('$') || p.includes('*')) continue;   // unresolvable at parse time
      if (/^\/(tmp|private\/tmp|var)\b/.test(p)) continue;  // scratch, not the project
      if (!/^[\w./~@+-]+$/.test(p)) continue;              // not a plausible path
      if (!p.includes('/') && !/\.[A-Za-z0-9]{1,6}$/.test(p)) continue;  // bare word, not a file
      out.push(p);
    }
  }
  return out.slice(0, 8);   // one command does not legitimately write dozens of files
}

// The cwd basename is a poor repo name: a worktree yields its branch-suffixed
// directory, and running from $HOME yields the username. Ask git for the shared
// repository instead, which is stable across worktrees.
function repoName(cwd) {
  if (!cwd) return '';
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
    if (common) {
      const root = path.basename(common) === '.git' ? path.dirname(common) : common;
      if (root && root !== os.homedir()) return path.basename(root);
    }
  } catch { /* not a repo, or no git */ }
  if (path.resolve(cwd) === os.homedir()) return '';
  return path.basename(cwd);
}

async function parseTranscript(file) {
  const s = {
    toolCalls: 0, tokens: 0, errors: 0, files: new Set(),
    added: 0, removed: 0, first: null, last: null, moving: 0, prompt: '', cwd: '',
    shellFiles: new Set(), models: {},
  };
  // Strava auto-pauses when you stop moving; a resumed session otherwise clocks
  // days of idle wall-clock as "moving time".
  const GAP_CAP_MS = 300_000;
  let prevTs = null;
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
      if (prevTs !== null && ts > prevTs) s.moving += Math.min(ts - prevTs, GAP_CAP_MS);
      prevTs = ts;
    }
    if (!s.cwd && d.cwd) s.cwd = d.cwd;

    if (d.type === 'assistant') {
      const m = d.message || {};
      if (m.model) s.models[m.model] = (s.models[m.model] || 0) + 1;
      const u = m.usage || {};
      // Cache reads are excluded: they are context replayed, not work done.
      s.tokens += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
      for (const b of m.content || []) {
        if (!b || b.type !== 'tool_use') continue;
        s.toolCalls++;
        if (b.name === 'Bash') {
          for (const p of bashWrites((b.input || {}).command)) s.shellFiles.add(p);
        }
      }
      continue;
    }

    if (d.type !== 'user') continue;

    const content = (d.message || {}).content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b && b.type === 'tool_result' && b.is_error) s.errors++;
      }
    } else if (typeof content === 'string' && !s.prompt && !d.isMeta && !d.toolUseResult) {
      s.prompt = content.trim();
    }

    const r = d.toolUseResult;
    if (!r || typeof r !== 'object') continue;
    const fp = r.filePath || (r.file && r.file.filePath);
    if (fp) s.files.add(fp);

    if (Array.isArray(r.structuredPatch)) {
      for (const hunk of r.structuredPatch) {
        for (const l of hunk.lines || []) {
          if (l.startsWith('+')) s.added++;
          else if (l.startsWith('-')) s.removed++;
        }
      }
    } else if (r.type === 'create' && typeof r.content === 'string') {
      s.added += r.content.split('\n').length;
    }
  }
  return s;
}

// The session names its own shape from what actually happened in it.
function inferType(s, net) {
  // A heavy session with no recorded file edits is usually mis-measured (see the
  // Bash-heredoc caveat in the README), not genuinely a reading session.
  if (s.files.size === 0) return s.toolCalls >= 60 ? 'chore' : 'research';
  if (s.errors >= 3) return 'debug';
  if (net < 0 && s.added + s.removed > 60) return 'refactor';
  if (s.added + s.removed < 40) return 'chore';
  return 'feature';
}


// Prompts routinely name customers, vendors and internal projects. This cannot be
// detected reliably, so flag the obvious cases and let the summary be switched off
// entirely via config: { "summaries": "off" }.
const ORG_HINT = /\b(LIMITED|LTD|LLC|INC|GMBH|B\.?V\.?|S\.?A\.?|PRIVATE|HOLDINGS?|d\.o\.o\.?|s\.r\.o\.?)\b/i;
const ALLCAPS_RUN = /\b[A-Z][A-Z0-9&.'-]{2,}(?:\s+[A-Z][A-Z0-9&.'-]{2,}){1,}\b/;

export function summaryLooksSensitive(text) {
  if (!text) return null;
  if (ORG_HINT.test(text)) return 'names what looks like a company';
  if (ALLCAPS_RUN.test(text)) return 'contains a capitalised proper name';
  return null;
}

// The first prompt becomes the card's subtitle, and cards get shared — so strip
// the @-file mentions and absolute paths that carry the machine's directory layout.
function cleanSummary(raw) {
  return String(raw || '')
    .replace(/@"[^"]*"/g, '')                       // @"/Users/me/proj/" mentions
    .replace(/@\/[^\s]+/g, '')                       // bare @/path mentions
    .replace(new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '~')
    .replace(/(?:\/[\w.@+-]+){3,}\/?/g, (m) => '…/' + m.split('/').filter(Boolean).slice(-1)[0])
    .replace(/\s+/g, ' ')
    .trim();
}

// Parse one transcript and upsert it as an activity.
// Returns { skipped } when the session is below the floor, else the activity,
// which badges/PRs are newly earned since its last log, and the card path.
export async function logSession({ sessionId, transcriptPath, cwd, drawCard = true, dry = false }) {
  if (!sessionId || !transcriptPath || !fs.existsSync(transcriptPath)) {
    return { skipped: 'missing transcript' };
  }
  if (fs.statSync(transcriptPath).size > MAX_TRANSCRIPT_BYTES) {
    return { skipped: 'transcript too large' };
  }
  const s = await parseTranscript(transcriptPath);
  return storeSession({ sessionId, stats: s, cwd, drawCard, dry });
}

// Everything downstream of parsing: thresholds, activity shape, badges, records,
// card. Shared by the Claude Code transcript parser and the Cursor DB parser.
export function storeSession({ sessionId, stats: s, cwd, drawCard = true, dry = false, client = 'claude-code' }) {
  const duration = Math.round(s.moving / 1000);
  if (s.toolCalls < MIN_TOOL_CALLS) return { skipped: `only ${s.toolCalls} tool calls` };
  if (duration < MIN_SECONDS) return { skipped: `only ${duration}s of moving time` };

  for (const p of s.shellFiles) s.files.add(path.resolve(cwd || s.cwd || '.', p));

  const languages = [...new Set([...s.files]
    .map((f) => EXT_LANG[path.extname(f).slice(1).toLowerCase()])
    .filter(Boolean))].slice(0, 6);

  const activity = clean({
    date: s.first ? new Date(s.first).toISOString() : undefined,
    type: inferType(s, s.added - s.removed),
    model: s.model || dominantModel(s.models) || undefined,
    repo: repoName(cwd || s.cwd),
    summary: config().summaries === 'off' ? '' : cleanSummary(s.prompt).slice(0, 160),
    duration_seconds: duration,
    tool_calls: s.toolCalls,
    files_changed: s.files.size,
    lines_added: s.added,
    lines_removed: s.removed,
    tokens: s.tokens,
    errors_recovered: Math.min(s.errors, 20),
    edits_accepted: s.accepted || 0,
    edits_rejected: s.rejected || 0,
    languages,
  });
  activity.session_id = sessionId;
  activity.source = 'hook';
  activity.client = client;

  const history = all();
  const before = history.find((a) => a.session_id === sessionId);
  const badges = badgesFor(activity);
  // A record only counts against sessions other than this one.
  const prs = prsFor(activity, history.filter((a) => a.session_id !== sessionId));

  // A dry run computes everything and writes nothing.
  if (dry) return { activity, stored: activity, badges, prs, fresh: [], card: null, isNew: !before, dry: true };

  const { activity: stored } = upsertBySession(sessionId, {
    ...activity,
    badges: badges.map((b) => b.id),
    prs: prs.map((p) => p.id),
  });

  let card = null;
  if (drawCard) {
    const svg = renderCard({ ...activity, id: stored.id, date: stored.date },
      { badges, prs, streak: streak([...history, activity]) });
    const out = writeCard(stored.id, svg);
    card = out.pngPath || out.svgPath;
    upsertBySession(sessionId, { ...stored, card });
  }

  const earned = new Set(before ? [...(before.badges || []), ...(before.prs || [])] : []);
  const fresh = [
    ...prs.filter((p) => !earned.has(p.id)).map((p) => p.name + ' PR'),
    ...badges.filter((b) => !earned.has(b.id)).map((b) => b.name),
  ];

  return { activity, stored, badges, prs, fresh, card, isNew: !before };
}

export { parseTranscript, MIN_TOOL_CALLS, MIN_SECONDS };
