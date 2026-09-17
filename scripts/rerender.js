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
import fs from 'node:fs';
import path from 'node:path';
import { all, CARDS_DIR } from '../src/store.js';
import { redrawCards } from '../src/redraw.js';

const args = process.argv.slice(2);
const PRUNE = args.includes('--prune');
const only = args.find((a) => !a.startsWith('--'));
const drawn = redrawCards((a) => !only || a.id === only);
if (!drawn.length) { console.error(only ? `No activity ${only}` : 'Nothing logged yet.'); process.exit(1); }
for (const f of drawn) console.log(f);

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
