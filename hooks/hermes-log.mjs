#!/usr/bin/env node
// Agentrava shell hook for Hermes Agent, registered under on_session_end in
// ~/.hermes/config.yaml. Hermes fires that event at the end of every turn and
// pipes {session_id, cwd, profile, …} to stdin, with HERMES_HOME set to the
// profile that fired it — so the session is read from that profile's database.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf));
    setTimeout(() => resolve(buf), 3000).unref();
  });
}

async function main() {
  let hook = {};
  try { hook = JSON.parse((await readStdin()) || '{}'); } catch { return; }
  if (!hook.session_id) return;

  const { parseHermesSession, HERMES_HOME } = await import(path.join(HERE, '../src/hermes.js'));
  const { storeSession } = await import(path.join(HERE, '../src/session.js'));
  const { derive } = await import(path.join(HERE, '../src/metrics.js'));
  const { HOME } = await import(path.join(HERE, '../src/store.js'));

  const { inferRepo } = await import(path.join(HERE, '../src/cursor.js'));

  const stats = parseHermesSession(hook.session_id, path.join(HERMES_HOME, 'state.db'));
  // A gateway turn reports the gateway's directory, not a project; the files it
  // edited say more.
  const cwd = stats.cwd || inferRepo(stats.files) || hook.cwd || '';
  const r = await storeSession({ sessionId: stats.id, stats, cwd, client: 'hermes' });
  if (r.skipped) return;

  const d = derive(r.activity);
  fs.appendFileSync(path.join(HOME, 'hook.log'),
    `${new Date().toISOString()} hermes ${stats.id.slice(0, 15)} ${r.activity.title} ` +
    `${d.distance_km.toFixed(2)}km ${Math.round(d.elevation_m)}m ${r.activity.duration_seconds}s ` +
    `${r.activity.tool_calls} calls ${r.activity.tokens} tok` +
    `${r.fresh.length ? ' NEW: ' + r.fresh.join(', ') : ''}\n`);
}

main().catch((err) => {
  try {
    fs.appendFileSync(path.join(os.homedir(), '.agentrava', 'hook.log'),
      `${new Date().toISOString()} ERROR hermes ${err && err.message}\n`);
  } catch { /* the hook must never break the session */ }
});
