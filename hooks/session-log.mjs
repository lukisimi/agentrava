#!/usr/bin/env node
// Agentrava Stop hook. Runs on every Stop and upserts the session's activity, so
// the entry grows with the session and survives a session that is killed rather
// than closed. All the work lives in ../src/session.js.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { logSession } = await import(path.join(HERE, '../src/session.js'));
const { derive } = await import(path.join(HERE, '../src/metrics.js'));
const { HOME } = await import(path.join(HERE, '../src/store.js'));

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

  const r = await logSession({
    sessionId: hook.session_id,
    transcriptPath: hook.transcript_path,
    cwd: hook.cwd,
  });
  if (r.skipped) return;

  const d = derive(r.activity);
  fs.appendFileSync(path.join(HOME, 'hook.log'),
    `${new Date().toISOString()} ${hook.session_id.slice(0, 8)} ${r.activity.title} ` +
    `${d.distance_km.toFixed(2)}km ${Math.round(d.elevation_m)}m ${r.activity.duration_seconds}s ` +
    `${r.activity.tool_calls} calls ${r.activity.tokens} tok` +
    `${r.fresh.length ? ' NEW: ' + r.fresh.join(', ') : ''}\n`);

  // Speak up once per session, and only for something actually earned.
  if (r.fresh.length && r.isNew) {
    process.stdout.write(JSON.stringify({
      systemMessage: `\u{1F3C5} Agentrava: ${r.activity.title} — ${d.distance_km.toFixed(2)} km, ` +
        `${Math.round(d.elevation_m)} m. ${r.fresh.slice(0, 3).join(', ')}`,
      suppressOutput: true,
    }));
  }
}

main().catch((err) => {
  try {
    fs.appendFileSync(path.join(os.homedir(), '.agentrava', 'hook.log'),
      `${new Date().toISOString()} ERROR ${err && err.message}\n`);
  } catch { /* the hook must never break the session */ }
});
