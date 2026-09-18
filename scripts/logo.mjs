#!/usr/bin/env node
// Client logos. No artwork ships with this repo — these are trademarks, and
// whether you may use one on a card you post is between you and the owner's
// brand guidelines. This installs a file you already have.
//
//   node scripts/logo.mjs                      what is installed
//   node scripts/logo.mjs codex ~/openai.svg   install one
//   node scripts/logo.mjs codex chat           use an image you just pasted
//   node scripts/logo.mjs codex --remove
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CLIENTS, LOGO_DIR } from '../src/clients.js';
import { latestPastedImage } from '../src/photo.js';
import { resolveTranscript } from '../src/transcripts.js';
import { redrawCards } from '../src/redraw.js';
import { all } from '../src/store.js';

const MAX = 512 * 1024;
const argv = process.argv.slice(2);
const [key, src] = argv.filter((a) => a !== '--remove');
const REMOVE = argv.includes('--remove');

function installed() {
  const rows = [];
  for (const k of Object.keys(CLIENTS)) {
    const f = ['svg', 'png'].map((e) => path.join(LOGO_DIR, `${k}.${e}`)).find((p) => fs.existsSync(p));
    const n = all().filter((a) => a.client === k).length;
    if (f || n) rows.push({ k, f, n });
  }
  return rows;
}

if (!key) {
  const rows = installed();
  if (!rows.length) console.log('No logos installed, and nothing logged yet.');
  for (const r of rows) {
    console.log(`  ${r.k.padEnd(12)} ${String(r.n).padStart(4)} sessions  ${r.f ? path.basename(r.f) : '— dot only'}`);
  }
  console.log(`\nLogos live in ${LOGO_DIR}. Cards show a coloured dot until one is installed.`);
  process.exit(0);
}

if (!CLIENTS[key]) {
  console.error(`Unknown client "${key}". Known: ${Object.keys(CLIENTS).join(', ')}`);
  process.exit(1);
}

if (REMOVE) {
  let gone = 0;
  for (const ext of ['svg', 'png']) {
    const f = path.join(LOGO_DIR, `${key}.${ext}`);
    if (fs.existsSync(f)) { fs.unlinkSync(f); gone++; }
  }
  if (!gone) { console.log(`No logo installed for ${key}.`); process.exit(0); }
  console.log(`Removed. Redrew ${redrawCards((a) => a.client === key).length} cards — back to the dot.`);
  process.exit(0);
}

if (!src) { console.error(`usage: logo.mjs ${key} <file.svg|file.png|chat>`); process.exit(1); }

let file;
if (['chat', 'pasted', 'latest'].includes(src.toLowerCase())) {
  const t = resolveTranscript(null);
  const img = latestPastedImage(t && t.file, path.join(os.tmpdir(), 'agentrava-logo'));
  if (!img) { console.error('No image found in this conversation — paste one, then try again.'); process.exit(1); }
  file = img.path;
} else {
  file = path.resolve(src.replace(/^~(?=\/)/, os.homedir()));
}

if (!fs.existsSync(file)) { console.error(`No such file: ${file}`); process.exit(1); }
const ext = path.extname(file).toLowerCase() === '.svg' ? 'svg' : 'png';
if (!['.svg', '.png'].includes(path.extname(file).toLowerCase())) {
  console.error('Logos must be .svg or .png — those are the two the card embeds.');
  process.exit(1);
}
const size = fs.statSync(file).size;
if (size > MAX) { console.error(`${(size / 1024).toFixed(0)} KB is over the 512 KB cap.`); process.exit(1); }

fs.mkdirSync(LOGO_DIR, { recursive: true });
// One file per client: installing a png replaces an svg rather than racing it.
for (const e of ['svg', 'png']) { const f = path.join(LOGO_DIR, `${key}.${e}`); if (fs.existsSync(f)) fs.unlinkSync(f); }
const dest = path.join(LOGO_DIR, `${key}.${ext}`);
fs.copyFileSync(file, dest);
console.log(`${CLIENTS[key].label} logo installed (${(size / 1024).toFixed(0)} KB).`);
console.log(`Redrew ${redrawCards((a) => a.client === key).length} cards.`);
