// Render a season recap from the logged activities. Optional YYYY-MM-DD bounds.
import { all } from '../src/store.js';
import { renderRecap } from '../src/recap.js';
import { writeCard } from '../src/render.js';

const [from, to] = process.argv.slice(2);
let acts = all();
if (from) acts = acts.filter((a) => a.date.slice(0, 10) >= from);
if (to) acts = acts.filter((a) => a.date.slice(0, 10) <= to);
if (!acts.length) { console.error('No activities in that range.'); process.exit(1); }

const out = writeCard(`recap-${from || 'all'}${to ? '-' + to : ''}`, renderRecap(acts));
console.log(out.pngPath || out.svgPath, `(${acts.length} activities)`);
