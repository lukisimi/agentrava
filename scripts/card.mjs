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
//   node scripts/card.mjs <id> --route left --route-scale 0.7  move the trace off the subject
//   node scripts/card.mjs <id> --route auto                    back to the default placement
//   node scripts/card.mjs <id> --summary "text"                replace the subtitle
//   node scripts/card.mjs <id> --no-summary                    drop it before sharing
//   node scripts/card.mjs <id> --title "Fixed the login loop"  rename it (rename.mjs session <id> --reset undoes)
//   node scripts/card.mjs <id> --share friends                 no cost, economy or diff footer
//   node scripts/card.mjs <id> --share anonymous               also no photo, avatar, name, title, subtitle, project
//   node scripts/card.mjs <id> --share full                    everything again
import { all, load, save } from '../src/store.js';
import path from 'node:path';
import { derive, fmtDuration, fmtPace, fmtNum } from '../src/metrics.js';
import { badgesFor, streak, RECORD_NAMES } from '../src/achievements.js';
import { summaryLooksSensitive } from '../src/session.js';
import { renderCard } from '../src/card.js';
import { writeCard } from '../src/render.js';
import { photoDataUri, resolvePhotoPath } from '../src/photo.js';
import { setOverride, withPresentation, overrideKey } from '../src/store.js';
import { ROUTE_POSITIONS, SHARE_LEVELS } from '../src/card.js';
import { resolveTranscript } from '../src/transcripts.js';
import { renameSession } from '../src/names.js';
import { upsertBySession, presentAll } from '../src/store.js';

function persist(a) {
  if (a.session_id) return upsertBySession(a.session_id, a);
  const db = load();
  const i = db.activities.findIndex((x) => x.id === a.id);
  if (i >= 0) { db.activities[i] = a; save(db); }
}

// Raw records for saving; resolved names (renames, project display names) for
// listing and matching. Saving a resolved record would bake display-only fields
// into the store.
const acts = all().slice().sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
if (!acts.length) { console.error('Nothing logged yet.'); process.exit(1); }
const shown = new Map(presentAll(acts).map((a) => [a.id, a]));
const view = (a) => shown.get(a.id) || a;

const args = process.argv.slice(2);
const photoIdx = args.indexOf('--photo');
const photoArg = photoIdx >= 0 ? args[photoIdx + 1] : null;
const clearPhoto = args.includes('--no-photo');
const routeIdx = args.indexOf('--route');
const routeArg = routeIdx >= 0 ? args[routeIdx + 1] : null;
const scaleIdx = args.indexOf('--route-scale');
const scaleArg = scaleIdx >= 0 ? Number(args[scaleIdx + 1]) : null;
const titleIdx = args.indexOf('--title');
const titleArg = titleIdx >= 0 ? args[titleIdx + 1] : null;
const shareIdx = args.indexOf('--share');
const shareArg = shareIdx >= 0 ? args[shareIdx + 1] : null;
const flagValues = new Set([photoIdx, routeIdx, scaleIdx, titleIdx, shareIdx].filter((i) => i >= 0).map((i) => i + 1));
const sumIdx = args.indexOf('--summary');
const newSummary = sumIdx >= 0 ? args[sumIdx + 1] : null;
const clearSummary = args.includes('--no-summary');
// photoIdx is -1 when --photo is absent, so guard before excluding its value.
const arg = args.filter((a, i) => !a.startsWith('--')
  && !flagValues.has(i) && !(sumIdx >= 0 && i === sumIdx + 1))[0];
const line = (a) => {
  const d = derive(a);
  return `${new Date(a.date).toLocaleDateString('en-CA')}  ${(a.session_id || a.id).slice(0, 8)}  ` +
    `${d.distance_km.toFixed(1).padStart(6)} km  ${fmtDuration(a.duration_seconds).padStart(9)}  ` +
    `${view(a).title.padEnd(21)} ${view(a).project_name || '—'}`;
};

// These are flags, so the positional filter above never yields them.
if (args.includes('--list') || args.includes('-l')) {
  for (const a of acts.slice(-25)) console.log(line(a));
  process.exit(0);
}

let target;

if (args.includes('--best')) target = acts.reduce((m, a) => derive(a).distance_km > derive(m).distance_km ? a : m);
else if (!arg) target = acts[acts.length - 1];
else {
  const q = arg.toLowerCase();
  target = acts.find((a) => (a.session_id || '').startsWith(arg) || a.id === arg)
    || acts.slice().reverse().find((a) => `${a.repo} ${view(a).project_name} ${view(a).title}`.toLowerCase().includes(q));
}
if (!target) { console.error(`No activity matching "${arg}". Try --list.`); process.exit(1); }

// Redraw from stored data with the current renderer, keeping the id so the route
// stays the same trace it has always been.
if (newSummary !== null || clearSummary) {
  target = { ...target, summary: clearSummary ? '' : newSummary };
  persist(target);
}

// Presentation choices go to the overrides store, so re-logging and forced
// backfills keep them.
if (photoArg || clearPhoto) {
  const tx = resolveTranscript(null, process.env.HOME);
  const photoPath = clearPhoto ? null : resolvePhotoPath(photoArg, tx && tx.file);
  if (photoPath) photoDataUri(photoPath);          // validate before storing
  setOverride(overrideKey(target), { photo: photoPath });
  if (target.photo !== undefined) { target = { ...target }; delete target.photo; persist(target); }
}
if (routeArg || scaleArg) {
  if (routeArg && routeArg !== 'auto' && !ROUTE_POSITIONS.includes(routeArg)) {
    console.error(`--route must be one of: ${ROUTE_POSITIONS.join(', ')}, auto`); process.exit(1);
  }
  const cur = withPresentation(target).route || {};
  const next = routeArg === 'auto' ? null
    : { ...cur, ...(routeArg ? { position: routeArg } : {}), ...(scaleArg ? { scale: scaleArg } : {}) };
  setOverride(overrideKey(target), { route: next });
}
if (titleArg !== null) {
  try { renameSession(target.id, titleArg); }
  catch (err) { console.error(`${err.message} (undo a rename with: node scripts/rename.mjs session <id> --reset)`); process.exit(1); }
}
if (shareArg !== null) {
  if (!SHARE_LEVELS.includes(shareArg)) { console.error(`--share must be one of: ${SHARE_LEVELS.join(', ')}`); process.exit(1); }
  setOverride(overrideKey(target), { share: shareArg === 'full' ? null : shareArg });
}
target = withPresentation(target);

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
const risk = summaryLooksSensitive(target.summary);
if (risk) console.log(`\n  ⚠  subtitle ${risk} — before sharing, run:\n     node scripts/card.mjs ${(target.session_id || target.id).slice(0, 8)} --no-summary`);
// Token accounting lives here now; it no longer fits on the card.
if (target.tokens_in || target.tokens_out || target.tokens_cache_read) {
  console.log(`  tokens: ${fmtNum(target.tokens_in)} in · ${fmtNum(target.tokens_out)} out · ` +
    `${fmtNum(target.tokens_cache_write)} cache write · ${fmtNum(target.tokens_cache_read)} cache read`);
}
if (target.photo || target.route || target.share) {
  console.log(`  presentation: ${[target.photo ? 'photo' : '', target.route ? `route ${target.route.position || 'auto'} ×${target.route.scale ?? 'default'}` : '',
    target.share ? `share ${target.share}` : ''].filter(Boolean).join(', ')}`);
}
// The title is generated from the clock and type, so it often misses what the
// session was about; say how to fix that rather than leave it to be found.
// An activity id only matches whole; a session id matches by prefix.
const short = target.session_id ? target.session_id.slice(0, 8) : target.id;
if (target.title === target.generated_title) console.log(`\n  title "${target.title}" is generated — rename it: node scripts/card.mjs ${short} --title "…"`);
if (!target.share) console.log(`  posting it? --share friends drops cost and the diff; --share anonymous also drops photo, name and project`);
console.log(`\n${out.pngPath || out.svgPath}`);
