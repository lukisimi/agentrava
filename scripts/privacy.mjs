#!/usr/bin/env node
// Which stored cards carry a subtitle that should not be shared?
//
//   node scripts/privacy.mjs            list flagged activities
//   node scripts/privacy.mjs --strip    blank every flagged subtitle
//   node scripts/privacy.mjs --strip-all  blank every subtitle, flagged or not
import { all, load, save, setConfig } from '../src/store.js';
import { summaryLooksSensitive } from '../src/session.js';

const STRIP = process.argv.includes('--strip');
const STRIP_ALL = process.argv.includes('--strip-all');
const acts = all();
const flagged = acts.filter((a) => a.summary && summaryLooksSensitive(a.summary));

console.log(`${acts.length} activities · ${acts.filter((a) => a.summary).length} carry a subtitle · ${flagged.length} flagged\n`);
for (const a of flagged.slice(0, 20)) {
  console.log(`  ${a.date.slice(0, 10)}  ${(a.session_id || a.id).slice(0, 8)}  ${summaryLooksSensitive(a.summary)}`);
  console.log(`      "${a.summary.slice(0, 96)}${a.summary.length > 96 ? '…' : ''}"`);
}
if (flagged.length > 20) console.log(`  … and ${flagged.length - 20} more`);

if (STRIP || STRIP_ALL) {
  const db = load();
  let n = 0;
  for (const a of db.activities) {
    if (!a.summary) continue;
    if (STRIP_ALL || summaryLooksSensitive(a.summary)) { a.summary = ''; n++; }
  }
  save(db);
  console.log(`\nBlanked ${n} subtitle(s). Redraw with: node scripts/rerender.js`);
  if (STRIP_ALL) { setConfig({ summaries: 'off' }); console.log('Also set summaries: "off" so future sessions omit them.'); }
} else if (flagged.length) {
  console.log('\nFix: node scripts/privacy.mjs --strip     (blank just these)');
  console.log('     node scripts/privacy.mjs --strip-all (blank all, and stop recording them)');
}
