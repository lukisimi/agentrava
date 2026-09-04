#!/usr/bin/env node
// Render the card for ONE session.
//
//   node scripts/card.mjs                latest activity
//   node scripts/card.mjs --list         recent activities with their ids
//   node scripts/card.mjs --best         biggest by distance
//   node scripts/card.mjs b735d1e4       by session id prefix
//   node scripts/card.mjs act_mtmt…      by activity id
//   node scripts/card.mjs manystudio     by repo or title match
//   node scripts/card.mjs <id> --photo ~/me-in-a-hammock.jpg   attach a photo
//   node scripts/card.mjs <id> --photo chat                    use the image you just pasted
//   node scripts/card.mjs <id> --no-photo                      remove it
import { all, load, save } from '../src/store.js';
import path from 'node:path';
import { derive, fmtDuration, fmtPace } from '../src/metrics.js';
import { badgesFor, streak, RECORD_NAMES } from '../src/achievements.js';
import { renderCard } from '../src/card.js';
import { writeCard } from '../src/render.js';
import { photoDataUri, resolvePhotoPath } from '../src/photo.js';
import { resolveTranscript } from '../src/transcripts.js';
import { upsertBySession } from '../src/store.js';

const acts = all().slice().sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
if (!acts.length) { console.error('Nothing logged yet.'); process.exit(1); }

const args = process.argv.slice(2);
const photoIdx = args.indexOf('--photo');
const photoArg = photoIdx >= 0 ? args[photoIdx + 1] : null;
const clearPhoto = args.includes('--no-photo');
// photoIdx is -1 when --photo is absent, so guard before excluding its value.
const arg = args.filter((a, i) => !a.startsWith('--') && !(photoIdx >= 0 && i === photoIdx + 1))[0];
const line = (a) => {
  const d = derive(a);
  return `${new Date(a.date).toLocaleDateString('en-CA')}  ${(a.session_id || a.id).slice(0, 8)}  ` +
    `${d.distance_km.toFixed(1).padStart(6)} km  ${fmtDuration(a.duration_seconds).padStart(9)}  ` +
    `${a.title.padEnd(21)} ${a.repo || '—'}`;
};

if (arg === '--list' || arg === '-l') {
  for (const a of acts.slice(-25)) console.log(line(a));
  process.exit(0);
}

let target;

if (!arg) target = acts[acts.length - 1];
else if (arg === '--best') target = acts.reduce((m, a) => derive(a).distance_km > derive(m).distance_km ? a : m);
else {
  const q = arg.toLowerCase();
  target = acts.find((a) => (a.session_id || '').startsWith(arg) || a.id === arg)
    || acts.reverse().find((a) => `${a.repo} ${a.title}`.toLowerCase().includes(q));
}
if (!target) { console.error(`No activity matching "${arg}". Try --list.`); process.exit(1); }

// Redraw from stored data with the current renderer, keeping the id so the route
// stays the same trace it has always been.
// A photo is remembered on the activity, so later redraws keep it.
if (photoArg || clearPhoto) {
  const tx = resolveTranscript(null, process.env.HOME);
  const photoPath = clearPhoto ? null : resolvePhotoPath(photoArg, tx && tx.file);
  if (photoPath) photoDataUri(photoPath);          // validate before storing
  target = { ...target, photo: photoPath };
  if (target.session_id) upsertBySession(target.session_id, target);
  else { const db = load(); const i = db.activities.findIndex((x) => x.id === target.id);
         if (i >= 0) { db.activities[i] = target; save(db); } }
}

const badges = badgesFor(target);
const prs = (target.prs || []).map((id) => ({ id, name: RECORD_NAMES[id] || id }));
const photo = target.photo ? photoDataUri(target.photo) : null;
const out = writeCard(target.id, renderCard(target, { badges, prs, streak: streak(all()), photo }));

const d = derive(target);
console.log(line(target));
console.log(`  ${d.distance_km.toFixed(2)} km · ${Math.round(d.elevation_m)} m · ${fmtDuration(target.duration_seconds)} · ` +
  `${fmtPace(d.pace_min_per_km)}/km · effort ${d.effort} · ${target.tool_calls} calls · ` +
  `${target.files_changed} files · ${target.errors_recovered} errors`);
if (prs.length) console.log(`  PR: ${prs.map((p) => p.name).join(', ')}`);
console.log(`  ${badges.map((b) => b.name).join(', ') || 'no badges'}`);
console.log(`\n${out.pngPath || out.svgPath}`);
