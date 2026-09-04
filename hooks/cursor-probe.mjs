#!/usr/bin/env node
// One-shot probe: capture exactly what Cursor hands a hook, so the real
// integration is written against observed fields rather than assumed ones.
// Appends one record per invocation; safe to leave installed, harmless to remove.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OUT = path.join(os.homedir(), '.agentrava', 'cursor-probe.jsonl');

const read = () => new Promise((resolve) => {
  let b = '';
  if (process.stdin.isTTY) return resolve('');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { b += d; });
  process.stdin.on('end', () => resolve(b));
  setTimeout(() => resolve(b), 3000).unref();
});

try {
  const raw = await read();
  let parsed = null;
  try { parsed = JSON.parse(raw || '{}'); } catch { /* record the raw text instead */ }

  // Does transcript_path actually point at something readable, and what is it?
  let transcript = null;
  const tp = parsed && parsed.transcript_path;
  if (tp) {
    try {
      const st = fs.statSync(tp);
      const fd = fs.openSync(tp, 'r');
      const buf = Buffer.alloc(Math.min(2000, st.size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      transcript = { path: tp, exists: true, bytes: st.size, head: buf.toString('utf8') };
    } catch (e) {
      transcript = { path: tp, exists: false, error: e.message };
    }
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.appendFileSync(OUT, JSON.stringify({
    at: new Date().toISOString(),
    argv: process.argv.slice(2),
    fields: parsed ? Object.keys(parsed).sort() : null,
    payload: parsed,
    rawLength: raw.length,
    rawHead: parsed ? undefined : raw.slice(0, 800),
    transcript,
  }) + '\n');
} catch { /* a probe must never break the editor */ }

process.stdout.write('{}');   // no-op response: never block or alter the turn
