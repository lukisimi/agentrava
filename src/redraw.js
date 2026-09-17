// Redraw stored cards with everything that is shown rather than measured —
// renames, project display names, photos, route placement. Changing a name in a
// table does nothing to a PNG already on disk, so every edit ends here.
import { all, presentAll } from './store.js';
import { renderCard } from './card.js';
import { writeCard } from './render.js';
import { photoFor } from './photo.js';
import { badgesFor, streak, RECORD_NAMES } from './achievements.js';

export function redrawCards(filter = () => true) {
  const everything = all();
  const run = streak(everything);          // the streak is global, not per selection
  const out = [];
  for (const a of presentAll(everything)) {
    if (!filter(a)) continue;
    const prs = (a.prs || []).map((id) => ({ name: RECORD_NAMES[id] || id }));
    const file = writeCard(a.id, renderCard(a, { badges: badgesFor(a), prs, streak: run, photo: photoFor(a) }));
    out.push(file.pngPath || file.svgPath);
  }
  return out;
}
