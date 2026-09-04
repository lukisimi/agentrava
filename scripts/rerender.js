// Redraw stored activities with the current renderer, keeping their ids
// (and so their routes). Run after changing card.js.
import { all } from '../src/store.js';
import { renderCard } from '../src/card.js';
import { writeCard } from '../src/render.js';
import { photoDataUri } from '../src/photo.js';
import { badgesFor, streak, RECORD_NAMES } from '../src/achievements.js';

const only = process.argv[2];
const acts = all().filter((a) => !only || a.id === only);
if (!acts.length) { console.error(only ? `No activity ${only}` : 'Nothing logged yet.'); process.exit(1); }
for (const a of acts) {
  const prs = (a.prs || []).map((id) => ({ name: RECORD_NAMES[id] || id }));
  let photo = null;
  try { photo = a.photo ? photoDataUri(a.photo) : null; } catch { /* photo moved or deleted */ }
  const out = writeCard(a.id, renderCard(a, { badges: badgesFor(a), prs, streak: streak(acts), photo }));
  console.log(out.pngPath);
}
