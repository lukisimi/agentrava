#!/usr/bin/env node
// Log every past Claude Code session at once.
//
//   node scripts/backfill.mjs              log everything not yet logged
//   node scripts/backfill.mjs --dry-run    report what would be logged
//   node scripts/backfill.mjs --force      recompute sessions already logged
//   node scripts/backfill.mjs --no-cards   skip PNG rendering (much faster)
//   node scripts/backfill.mjs --limit 20   stop after N
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

import { logSession } from '../src/session.js';
import { all, save, load } from '../src/store.js';
import { derive, fmtDuration, fmtNum } from '../src/metrics.js';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const DRY = has('--dry-run'), FORCE = has('--force'), CARDS = !has('--no-cards');
const LIMIT = argv.includes('--limit') ? Number(argv[argv.indexOf('--limit') + 1]) || Infinity : Infinity;
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

// Transcripts are not all one level deep — some sit in subdirectories.
function findTranscripts(dir = PROJECTS, out = [], depth = 0) {
  if (depth > 4) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findTranscripts(full, out, depth + 1);
    else if (e.name.endsWith('.jsonl')) {
      try { out.push({ id: e.name.slice(0, -6), file: full, size: fs.statSync(full).size }); } catch { /* gone */ }
    }
  }
  return out;
}

// Sort by when the session STARTED, not by file mtime: personal records are
// judged against prior history, so replaying out of order would award them to
// whichever session happened to be logged first.
async function startTime(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    let n = 0;
    for await (const line of rl) {
      if (++n > 200) break;
      if (!line.includes('"timestamp"')) continue;
      try {
        const t = Date.parse(JSON.parse(line).timestamp);
        if (!Number.isNaN(t)) return t;
      } catch { /* keep looking */ }
    }
  } finally { rl.close(); }
  return fs.statSync(file).mtimeMs;
}

const t0 = Date.now();
const found = findTranscripts();
if (!found.length) {
  console.error(`No transcripts under ${PROJECTS}`);
  process.exit(1);
}
const mb = (found.reduce((n, f) => n + f.size, 0) / 1048576).toFixed(0);
process.stdout.write(`Found ${found.length} transcripts (${mb} MB). Ordering by session start… `);
for (const t of found) t.start = await startTime(t.file);
found.sort((a, b) => a.start - b.start);
console.log(`done (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);

// --force must rebuild from empty. Replaying over a populated store judges every
// session against its own future, so only all-time bests keep a PR (17 -> 4 in
// testing). Back up first; the records are the point of ordering this run.
if (FORCE && !DRY) {
  const db = load();
  if (db.activities.length) {
    const bak = path.join(os.homedir(), '.agentrava', `activities.json.${Date.now()}.bak`);
    fs.writeFileSync(bak, JSON.stringify(db, null, 2));
    // Only Claude Code sessions are rebuilt here, so only those may be cleared —
    // wiping the whole store deletes every Cursor activity this script cannot restore.
    const keep = db.activities.filter((a) => a.client && a.client !== 'claude-code');
    const dropped = db.activities.length - keep.length;
    console.log(`--force: backed up ${db.activities.length} activities to ${path.basename(bak)}; ` +
      `rebuilding ${dropped} Claude Code one(s), keeping ${keep.length} from other clients\n`);
    save({ version: 1, activities: keep });
  }
}

const already = new Set(all().map((a) => a.session_id).filter(Boolean));
let logged = 0, skipped = 0, seen = 0;
const reasons = {};
const prsEarned = [];

for (const t of found) {
  if (logged >= LIMIT) break;
  seen++;
  if (!FORCE && already.has(t.id)) { skipped++; reasons['already logged'] = (reasons['already logged'] || 0) + 1; continue; }

  let r;
  try {
    r = await logSession({ sessionId: t.id, transcriptPath: t.file, drawCard: CARDS && !DRY, dry: DRY });
  } catch (err) {
    skipped++; reasons[`error: ${err.message}`] = (reasons[`error: ${err.message}`] || 0) + 1; continue;
  }

  if (r.skipped) { skipped++; reasons[r.skipped.replace(/\d+/g, 'N')] = (reasons[r.skipped.replace(/\d+/g, 'N')] || 0) + 1; continue; }

  logged++;
  const d = derive(r.activity);
  const date = new Date(r.activity.date).toISOString().slice(0, 10);
  const pr = r.prs.length ? `  \u{1F947} ${r.prs.map((p) => p.name).join(', ')}` : '';
  if (pr) prsEarned.push(`${date}  ${r.activity.title} — ${r.prs.map((p) => p.name).join(', ')}`);
  console.log(
    `${String(logged).padStart(3)}. ${date}  ${r.activity.title.padEnd(21)} ` +
    `${d.distance_km.toFixed(1).padStart(6)} km  ${String(Math.round(d.elevation_m)).padStart(5)} m  ` +
    `${fmtDuration(r.activity.duration_seconds).padStart(8)}  ${String(r.activity.tool_calls).padStart(4)} calls  ` +
    `${(r.activity.repo || '—').slice(0, 18).padEnd(18)}${pr}`);
}

const acts = all();
const tot = acts.reduce((a, x) => {
  const d = derive(x);
  a.km += d.distance_km; a.m += d.elevation_m; a.sec += x.duration_seconds;
  a.tok += x.tokens; a.calls += x.tool_calls; a.files += x.files_changed;
  a.added += x.lines_added; a.removed += x.lines_removed;
  return a;
}, { km: 0, m: 0, sec: 0, tok: 0, calls: 0, files: 0, added: 0, removed: 0 });

console.log(`\n${'─'.repeat(78)}`);
console.log(`Scanned ${seen}  ·  logged ${logged}  ·  skipped ${skipped}${DRY ? '  (dry run — nothing written)' : ''}`);
for (const [why, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(3)} × ${why}`);
console.log(`\nCAREER TOTALS (${acts.length} activities)`);
console.log(`  ${tot.km.toFixed(1)} km  ·  ${fmtNum(tot.m)} m climbed  ·  ${fmtDuration(tot.sec)} moving`);
console.log(`  ${fmtNum(tot.tok)} tokens  ·  ${fmtNum(tot.calls)} tool calls  ·  ${fmtNum(tot.files)} files  ·  +${fmtNum(tot.added)}/-${fmtNum(tot.removed)} lines`);
if (prsEarned.length) {
  console.log(`\nRECORDS AS THEY FELL (${prsEarned.length})`);
  for (const p of prsEarned.slice(-12)) console.log(`  ${p}`);
}
console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
