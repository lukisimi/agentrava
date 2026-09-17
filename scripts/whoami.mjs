#!/usr/bin/env node
// Set the name shown on every card.
//   node scripts/whoami.mjs "Your Name"
//   node scripts/whoami.mjs            (show the current name and avatar)
//   node scripts/whoami.mjs --avatar ~/face.jpg   picture for the circle
//   node scripts/whoami.mjs --avatar chat         use an image you just pasted
//   node scripts/whoami.mjs --no-avatar           back to the initial
import { all, load, save, config, setConfig } from '../src/store.js';
import { setAvatar } from '../src/avatar.js';
import { redrawCards } from '../src/redraw.js';
import { resolveTranscript } from '../src/transcripts.js';

const args = process.argv.slice(2);
const avIdx = args.indexOf('--avatar');
const clearAvatar = args.includes('--no-avatar');

if (avIdx >= 0 || clearAvatar) {
  const tx = resolveTranscript(null, process.env.HOME);
  try {
    const dest = setAvatar(clearAvatar ? null : args[avIdx + 1], tx && tx.file);
    console.log(dest ? `avatar set: ${dest}` : 'avatar cleared — cards show the initial again');
  } catch (err) { console.error(err.message); process.exit(1); }
  // The avatar is on every card, so every card has to be redrawn.
  console.log(`redrawing ${all().length} cards…`);
  console.log(`redrew ${redrawCards().length}`);
  process.exit(0);
}

const name = args.filter((a) => !a.startsWith('--')).join(' ').trim();
if (!name) {
  console.log(`athlete: ${config().athlete || '(unset — cards show "Athlete")'}`);
  console.log(`avatar : ${config().avatar || '(none — cards show the initial)'}`);
  console.log('set them with: node scripts/whoami.mjs "Your Name" · --avatar chat');
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
