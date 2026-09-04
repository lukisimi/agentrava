#!/usr/bin/env node
// Log Cursor sessions. Reads Cursor's SQLite chat store in one pass, then runs
// each conversation through the same pipeline as Claude Code sessions.
//
//   node scripts/cursor-backfill.mjs [--dry-run] [--no-cards] [--force] [--limit N]
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import { scanCursorDb, DEFAULT_DB } from '../src/cursor.js';
import { storeSession } from '../src/session.js';
import { all, save, load } from '../src/store.js';
import { derive, fmtDuration, fmtNum } from '../src/metrics.js';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const DRY = has('--dry-run'), FORCE = has('--force'), CARDS = !has('--no-cards');
const LIMIT = argv.includes('--limit') ? Number(argv[argv.indexOf('--limit') + 1]) || Infinity : Infinity;

// Cursor records absolute file paths but no working directory, so the repo is
// inferred from the deepest directory every touched file shares.
function commonDir(files) {
  const list = [...files];
  if (!list.length) return '';
  const split = list.map((f) => path.dirname(f).split(path.sep));
  const out = [];
  for (let i = 0; i < split[0].length; i++) {
    const seg = split[0][i];
    if (split.every((p) => p[i] === seg)) out.push(seg); else break;
  }
  const dir = out.join(path.sep);
  return dir && dir !== os.homedir() && dir.length > 1 ? dir : '';
}

const t0 = Date.now();
process.stdout.write(`Scanning ${path.basename(DEFAULT_DB)}… `);
const convos = [...scanCursorDb().values()]
  .filter((c) => c.first)
  .sort((a, b) => a.first - b.first);          // oldest first, so records fall in order
console.log(`${convos.length} conversations (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);

if (FORCE && !DRY) {
  const db = load();
  const keep = db.activities.filter((a) => a.client !== 'cursor');
  if (keep.length !== db.activities.length) {
    const bak = path.join(os.homedir(), '.agentrava', `activities.json.${Date.now()}.bak`);
    fs.writeFileSync(bak, JSON.stringify(db, null, 2));
    console.log(`--force: removed ${db.activities.length - keep.length} Cursor activities (backup ${path.basename(bak)})\n`);
    save({ ...db, activities: keep });
  }
}

const already = new Set(all().map((a) => a.session_id).filter(Boolean));
let logged = 0, skipped = 0;
const reasons = {};

for (const c of convos) {
  if (logged >= LIMIT) break;
  if (!FORCE && already.has(c.id)) { skipped++; reasons['already logged'] = (reasons['already logged'] || 0) + 1; continue; }

  const cwd = commonDir(c.files);
  // Cursor's churn is unusable, so it is reported as zero rather than wrong.
  // Only 3% of conversations record any diff at all, and where they do, the edit
  // tool stores the whole new file body — one session scored 381 km off +27k
  // "added" lines that were mostly unchanged text. A metric present for 3% of
  // sessions and inflated when present makes sessions incomparable; distance for
  // Cursor comes from tool calls alone.
  const stats = { ...c, added: 0, removed: 0 };
  const r = storeSession({ sessionId: c.id, stats, cwd, drawCard: CARDS && !DRY, dry: DRY, client: 'cursor' });
  if (r.skipped) { skipped++; const k = r.skipped.replace(/\d+/g, 'N'); reasons[k] = (reasons[k] || 0) + 1; continue; }

  logged++;
  const d = derive(r.activity);
  console.log(`${String(logged).padStart(3)}. ${r.activity.date.slice(0, 10)}  ${r.activity.title.padEnd(21)} ` +
    `${d.distance_km.toFixed(1).padStart(6)} km  ${String(Math.round(d.elevation_m)).padStart(5)} m  ` +
    `${fmtDuration(r.activity.duration_seconds).padStart(8)}  ${String(r.activity.tool_calls).padStart(4)} calls  ` +
    `${(r.activity.repo || '—').slice(0, 20)}` +
    `${r.prs.length ? '  🥇 ' + r.prs.map((p) => p.name).join(', ') : ''}`);
}

console.log(`\n${'─'.repeat(70)}`);
console.log(`Conversations ${convos.length}  ·  logged ${logged}  ·  skipped ${skipped}${DRY ? '  (dry run)' : ''}`);
for (const [w, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(3)} × ${w}`);
const cur = all().filter((a) => a.client === 'cursor');
if (cur.length) {
  const t = cur.reduce((a, x) => { const d = derive(x); a.km += d.distance_km; a.m += d.elevation_m; a.sec += x.duration_seconds; a.calls += x.tool_calls; return a; }, { km: 0, m: 0, sec: 0, calls: 0 });
  console.log(`\nCURSOR TOTALS (${cur.length} activities)`);
  console.log(`  ${t.km.toFixed(1)} km  ·  ${fmtNum(Math.round(t.m))} m  ·  ${fmtDuration(t.sec)} moving  ·  ${fmtNum(t.calls)} tool calls`);
}
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
