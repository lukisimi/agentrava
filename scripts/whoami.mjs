#!/usr/bin/env node
// Set the name shown on every card.
//   node scripts/whoami.mjs "Luka Pecavar"
//   node scripts/whoami.mjs            (show the current one)
import { all, load, save, config, setConfig } from '../src/store.js';

const name = process.argv.slice(2).join(' ').trim();
if (!name) {
  console.log(`athlete: ${config().athlete || '(unset — cards show "Athlete")'}`);
  console.log('set it with: node scripts/whoami.mjs "Your Name"');
  process.exit(0);
}
const clean = name.slice(0, 40);
setConfig({ athlete: clean });
const db = load();
let n = 0;
for (const a of db.activities) { if (a.athlete !== clean) { a.athlete = clean; n++; } }
save(db);
console.log(`athlete set to "${clean}" — updated ${n} of ${all().length} activities`);
console.log('redraw the cards with: node scripts/rerender.js');
