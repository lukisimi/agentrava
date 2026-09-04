// Redraw stored activities with the current renderer, keeping their ids
// (and so their routes). Run after changing card.js.
//
//   node scripts/rerender.js            redraw every activity
//   node scripts/rerender.js <id>       redraw one
//   node scripts/rerender.js --prune    also delete cards with no activity
//
// Pruning matters: a --force rebuild assigns new ids, so the previous card files
// are orphaned on disk and keep whatever text they were drawn with — including
// subtitles that have since been stripped.
import { all } from '../src/store.js';
import { renderCard } from '../src/card.js';
import { writeCard } from '../src/render.js';
import { photoDataUri } from '../src/photo.js';
import fs from 'node:fs';
import path from 'node:path';
import { CARDS_DIR } from '../src/store.js';
import { badgesFor, streak, RECORD_NAMES } from '../src/achievements.js';

const args = process.argv.slice(2);
const PRUNE = args.includes('--prune');
const only = args.find((a) => !a.startsWith('--'));
const acts = all().filter((a) => !only || a.id === only);
if (!acts.length) { console.error(only ? `No activity ${only}` : 'Nothing logged yet.'); process.exit(1); }
for (const a of acts) {
  const prs = (a.prs || []).map((id) => ({ name: RECORD_NAMES[id] || id }));
  let photo = null;
  try { photo = a.photo ? photoDataUri(a.photo) : null; } catch { /* photo moved or deleted */ }
  const out = writeCard(a.id, renderCard(a, { badges: badgesFor(a), prs, streak: streak(acts), photo }));
  console.log(out.pngPath);
}

if (PRUNE) {
  const live = new Set(all().map((a) => a.id));
  let removed = 0;
  for (const f of fs.readdirSync(CARDS_DIR)) {
    const m = f.match(/^(act_[a-z0-9]+)\.(png|svg)$/);
    if (!m || live.has(m[1])) continue;
    fs.unlinkSync(path.join(CARDS_DIR, f));
    removed++;
  }
  console.log(`pruned ${removed} orphaned card file(s)`);
}
