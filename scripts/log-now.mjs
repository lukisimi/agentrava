#!/usr/bin/env node
// Manually run what the Stop hook runs. Defaults to the most recently active
// session, so `npm run log` right after a piece of work does the right thing.
//
//   node scripts/log-now.mjs              most recent session anywhere
//   node scripts/log-now.mjs --list       show the 15 most recent, newest first
//   node scripts/log-now.mjs <id-prefix>  a specific session
//   node scripts/log-now.mjs <path.jsonl> an explicit transcript
//   node scripts/log-now.mjs --cursor     the Cursor conversation you are in
//   node scripts/log-now.mjs --cursor <id-prefix>
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, '../hooks/session-log.mjs');
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

function transcripts() {
  if (!fs.existsSync(PROJECTS)) return [];
  const out = [];
  for (const proj of fs.readdirSync(PROJECTS)) {
    const dir = path.join(PROJECTS, proj);
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        out.push({ id: f.replace(/\.jsonl$/, ''), file: full, mtime: st.mtimeMs, size: st.size, proj });
      } catch { /* vanished mid-scan */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// The transcript records the directory it ran in; that beats guessing from cwd.
async function cwdOf(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('"cwd"')) continue;
      try { const d = JSON.parse(line); if (d.cwd) return d.cwd; } catch { /* keep looking */ }
    }
  } finally { rl.close(); }
  return process.cwd();
}

const argv = process.argv.slice(2);
const CURSOR = argv.includes('--cursor');
const arg = argv.find((a) => !a.startsWith('--'));

if (CURSOR) {
  const { listConversations, parseCursorSession, inferRepo } = await import('../src/cursor.js');
  const { storeSession } = await import('../src/session.js');
  const { derive, fmtDuration } = await import('../src/metrics.js');

  const convs = listConversations();
  const conv = arg ? convs.find((c) => c.id.startsWith(arg)) : convs[0];
  if (!conv) { console.error(arg ? `No Cursor conversation starting with "${arg}".` : 'No Cursor conversations found.'); process.exit(1); }

  const stats = parseCursorSession(conv.id);
  // Cursor has no working directory; infer the repo from the files it touched.
  const cwd = inferRepo(stats.files) || '';

  const r = await storeSession({ sessionId: conv.id, stats, cwd, client: 'cursor' });
  if (r.skipped) { console.log(`Nothing logged for ${conv.id.slice(0, 8)} — ${r.skipped}.`); process.exit(0); }
  const d = derive(r.activity);
  console.log(`${r.activity.title}${r.activity.repo ? ' · ' + r.activity.repo : ''}  (Cursor)`);
  console.log(`  ${d.distance_km.toFixed(2)} km · ${Math.round(d.elevation_m)} m · ${fmtDuration(r.activity.duration_seconds)} · ` +
    `effort ${d.effort} · ${r.activity.tool_calls} tool calls · ${r.activity.files_changed} files`);
  if (r.badges.length) console.log(`  ${r.badges.map((b) => b.name).join(', ')}`);
  console.log(`\n${r.card}`);
  process.exit(0);
}
const list = transcripts();
if (!list.length) {
  console.error(`No transcripts under ${PROJECTS}`);
  process.exit(1);
}

if (arg === '--list' || arg === '-l') {
  const now = Date.now();
  for (const t of list.slice(0, 15)) {
    const mins = Math.round((now - t.mtime) / 60000);
    const age = mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`;
    console.log(`${t.id}  ${age.padStart(8)}  ${(t.size / 1048576).toFixed(1).padStart(5)} MB  ${t.proj}`);
  }
  process.exit(0);
}

let target;
if (arg && arg.endsWith('.jsonl')) {
  if (!fs.existsSync(arg)) { console.error(`No such transcript: ${arg}`); process.exit(1); }
  target = { id: path.basename(arg, '.jsonl'), file: path.resolve(arg) };
} else if (arg) {
  target = list.find((t) => t.id.startsWith(arg));
  if (!target) { console.error(`No session starting with "${arg}". Try --list.`); process.exit(1); }
} else {
  target = list[0];
}

const payload = JSON.stringify({
  session_id: target.id,
  transcript_path: target.file,
  cwd: await cwdOf(target.file),
  hook_event_name: 'Stop',
});

const logFile = path.join(process.env.AGENTRAVA_HOME || path.join(os.homedir(), '.agentrava'), 'hook.log');
const before = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').length : 0;

const child = spawn(process.execPath, [HOOK], { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.end(payload);
child.on('exit', () => {
  const lines = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trimEnd().split('\n') : [];
  const fresh = lines.slice(before - 1).filter(Boolean);
  if (fresh.length) console.log('\n' + fresh.join('\n'));
  else console.log(`\nNothing logged for ${target.id.slice(0, 8)} — under the 8 tool call / 2 minute floor.`);
});
