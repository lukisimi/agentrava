#!/usr/bin/env node
// Log Hermes Agent sessions from every profile's ~/.hermes state.db.
//
//   node scripts/hermes-backfill.mjs --dry-run   # report only
//   node scripts/hermes-backfill.mjs             # log every conversation
//   node scripts/hermes-backfill.mjs --force     # rebuild the Hermes ones
//   node scripts/hermes-backfill.mjs --no-cards
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { listHermesSessions, parseHermesSession, HERMES_HOME } from '../src/hermes.js';
import { inferRepo } from '../src/cursor.js';
import { storeSession } from '../src/session.js';
import { all, save, load } from '../src/store.js';
import { derive, fmtDuration, fmtNum } from '../src/metrics.js';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const DRY = has('--dry-run'), FORCE = has('--force'), CARDS = !has('--no-cards');
const LIMIT = argv.includes('--limit') ? Number(argv[argv.indexOf('--limit') + 1]) || Infinity : Infinity;

const t0 = Date.now();
const sessions = listHermesSessions();
if (!sessions.length) {
  console.error(`No Hermes sessions under ${HERMES_HOME}`);
  process.exit(1);
}
const sources = {};
for (const s of sessions) sources[s.source || 'unknown'] = (sources[s.source || 'unknown'] || 0) + 1;
console.log(`${sessions.length} Hermes conversations (${Object.entries(sources).map(([k, n]) => `${n} ${k}`).join(', ')})\n`);

// Only the Hermes ones may be cleared: this script cannot rebuild the others.
if (FORCE && !DRY) {
  const db = load();
  const keep = db.activities.filter((a) => a.client !== 'hermes');
  if (keep.length !== db.activities.length) {
    const bak = path.join(os.homedir(), '.agentrava', `activities.json.${Date.now()}.bak`);
    fs.writeFileSync(bak, JSON.stringify(db, null, 2));
    console.log(`--force: removed ${db.activities.length - keep.length} Hermes activities (backup ${path.basename(bak)})\n`);
    save({ ...db, activities: keep });
  }
}

const already = new Set(all().map((a) => a.session_id).filter(Boolean));
let logged = 0, skipped = 0;
const reasons = {};
const why = (r) => { skipped++; reasons[r] = (reasons[r] || 0) + 1; };

// Oldest first, so personal records land on the session that actually set them.
for (const h of sessions.slice().reverse()) {
  if (logged >= LIMIT) break;
  if (!FORCE && already.has(h.id)) { why('already logged'); continue; }
  let stats;
  try { stats = parseHermesSession(h.id, h.db); }
  catch (err) { why(`error: ${err.message}`); continue; }

  // A gateway session has no working directory of its own; fall back to the
  // project its edits landed in.
  const cwd = stats.cwd || inferRepo(stats.files) || '';
  const res = await storeSession({ sessionId: stats.id, stats, cwd, client: 'hermes', drawCard: CARDS && !DRY, dry: DRY });
  if (res.skipped) { why(res.skipped.replace(/\d+/g, 'N')); continue; }

  logged++;
  const d = derive(res.activity);
  console.log(`${String(logged).padStart(3)}. ${res.activity.date.slice(0, 10)}  ${res.activity.title.padEnd(21)} ` +
    `${d.distance_km.toFixed(1).padStart(6)} km  ${fmtDuration(res.activity.duration_seconds).padStart(9)}  ` +
    `${String(res.activity.tool_calls).padStart(4)} calls  ${(stats.source || '').padEnd(9)} ${(res.activity.repo || '—').slice(0, 22)}`);
}

console.log(`\n${'─'.repeat(70)}`);
console.log(`logged ${logged} · skipped ${skipped}${DRY ? '  (dry run)' : ''}`);
for (const [r, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(3)} × ${r}`);
const hermes = all().filter((a) => a.client === 'hermes');
if (hermes.length) {
  const t = hermes.reduce((acc, a) => {
    const d = derive(a);
    acc.km += d.distance_km; acc.sec += a.duration_seconds; acc.tok += a.tokens; acc.calls += a.tool_calls;
    return acc;
  }, { km: 0, sec: 0, tok: 0, calls: 0 });
  console.log(`\nHERMES TOTALS (${hermes.length})`);
  console.log(`  ${t.km.toFixed(1)} km · ${fmtDuration(t.sec)} · ${fmtNum(t.tok)} tokens · ${fmtNum(t.calls)} tool calls`);
}
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
