#!/usr/bin/env node
// Log Codex CLI sessions from ~/.codex/sessions.
//
//   node scripts/codex-backfill.mjs --dry-run   # report only
//   node scripts/codex-backfill.mjs             # log every rollout
//   node scripts/codex-backfill.mjs --force     # rebuild the Codex ones
//   node scripts/codex-backfill.mjs --no-cards
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findRollouts, parseCodexSession } from '../src/codex.js';
import { storeSession } from '../src/session.js';
import { all, save, load } from '../src/store.js';
import { derive, fmtDuration, fmtNum } from '../src/metrics.js';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const DRY = has('--dry-run'), FORCE = has('--force'), CARDS = !has('--no-cards');
const LIMIT = argv.includes('--limit') ? Number(argv[argv.indexOf('--limit') + 1]) || Infinity : Infinity;

const t0 = Date.now();
const rollouts = findRollouts();
if (!rollouts.length) {
  console.error(`No Codex rollouts under ${path.join(os.homedir(), '.codex', 'sessions')}`);
  process.exit(1);
}
const mb = (rollouts.reduce((n, r) => n + r.size, 0) / 1048576).toFixed(0);
console.log(`${rollouts.length} Codex sessions (${mb} MB)\n`);

// Only the Codex ones may be cleared: this script cannot rebuild the others.
if (FORCE && !DRY) {
  const db = load();
  const keep = db.activities.filter((a) => a.client !== 'codex');
  if (keep.length !== db.activities.length) {
    const bak = path.join(os.homedir(), '.agentrava', `activities.json.${Date.now()}.bak`);
    fs.writeFileSync(bak, JSON.stringify(db, null, 2));
    console.log(`--force: removed ${db.activities.length - keep.length} Codex activities (backup ${path.basename(bak)})\n`);
    save({ ...db, activities: keep });
  }
}

const already = new Set(all().map((a) => a.session_id).filter(Boolean));
let logged = 0, skipped = 0;
const reasons = {};

// Oldest first, so personal records land on the session that actually set them.
for (const r of rollouts.slice().reverse()) {
  if (logged >= LIMIT) break;
  if (!FORCE && already.has(r.id)) { skipped++; reasons['already logged'] = (reasons['already logged'] || 0) + 1; continue; }
  let stats;
  try { stats = await parseCodexSession(r.file); }
  catch (err) { skipped++; reasons[`error: ${err.message}`] = (reasons[`error: ${err.message}`] || 0) + 1; continue; }

  const res = await storeSession({ sessionId: r.id, stats, cwd: stats.cwd, client: 'codex', drawCard: CARDS && !DRY, dry: DRY });
  if (res.skipped) { skipped++; reasons[res.skipped.replace(/\d+/g, 'N')] = (reasons[res.skipped.replace(/\d+/g, 'N')] || 0) + 1; continue; }

  logged++;
  const d = derive(res.activity);
  console.log(`${String(logged).padStart(3)}. ${res.activity.date.slice(0, 10)}  ${res.activity.title.padEnd(21)} ` +
    `${d.distance_km.toFixed(1).padStart(6)} km  ${fmtDuration(res.activity.duration_seconds).padStart(9)}  ` +
    `${String(res.activity.tool_calls).padStart(4)} calls  ${(res.activity.repo || '—').slice(0, 22)}`);
}

console.log(`\n${'─'.repeat(70)}`);
console.log(`logged ${logged} · skipped ${skipped}${DRY ? '  (dry run)' : ''}`);
for (const [why, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(3)} × ${why}`);
const codex = all().filter((a) => a.client === 'codex');
if (codex.length) {
  const t = codex.reduce((acc, a) => {
    const d = derive(a);
    acc.km += d.distance_km; acc.sec += a.duration_seconds; acc.tok += a.tokens; acc.calls += a.tool_calls;
    return acc;
  }, { km: 0, sec: 0, tok: 0, calls: 0 });
  console.log(`\nCODEX TOTALS (${codex.length})`);
  console.log(`  ${t.km.toFixed(1)} km · ${fmtDuration(t.sec)} · ${fmtNum(t.tok)} tokens · ${fmtNum(t.calls)} tool calls`);
}
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
