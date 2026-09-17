#!/usr/bin/env node
// Weekly and Monthly Snap.
//
//   node scripts/snap.mjs week                  this week so far
//   node scripts/snap.mjs week last
//   node scripts/snap.mjs week 2026-09-07       the week containing that day
//   node scripts/snap.mjs month                 this month so far
//   node scripts/snap.mjs month 2026-08 --pick 4e374e0a
//   ... --title "Shipped the new onboarding"  --hide-projects
import { presentAll } from '../src/store.js';
import { resolvePeriod, dayKey } from '../src/periods.js';
import { summarize, fmtHM } from '../src/summary.js';
import { renderWeekly, renderMonthly } from '../src/snap.js';
import { writeCard } from '../src/render.js';
import { fmtUsd } from '../src/pricing.js';

const args = process.argv.slice(2);
const kind = args[0] === 'month' ? 'month' : args[0] === 'week' ? 'week' : null;
if (!kind) { console.error('usage: snap.mjs week|month [this|last|YYYY-MM-DD|YYYY-MM] [--pick id] [--title "…"] [--hide-projects]'); process.exit(1); }
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const flagValues = new Set(['--pick', '--title'].map((n) => args.indexOf(n)).filter((i) => i >= 0).map((i) => i + 1));
const spec = args.slice(1).find((a, i) => !a.startsWith('--') && !flagValues.has(i + 1));
const hideProjects = args.includes('--hide-projects');
const title = opt('--title');

const period = resolvePeriod(kind, spec);
const s = summarize(presentAll(), period, { pick: opt('--pick') });
if (opt('--pick') && !(s.feature && s.feature.selected)) {
  console.error(`--pick ${opt('--pick')} matched no session in this ${kind}.`); process.exit(1);
}

const svg = kind === 'week' ? renderWeekly(s, { title, hideProjects }) : renderMonthly(s, { title, hideProjects });
// The key names every variant, so an anonymised export never overwrites the plain one.
const key = ['snap', kind, dayKey(period.start.getTime()), period.rolling ? `r${period.rolling}` : '', hideProjects ? 'anon' : '', title ? 'titled' : '']
  .filter(Boolean).join('-');
const out = writeCard(key, svg);

console.log(period.rolling
  ? `Last ${period.rolling} days to ${dayKey(Date.now())}`
  : `${kind === 'week' ? 'Week' : 'Month'} of ${dayKey(period.start.getTime())}${s.partial ? ' (so far)' : ''}`);
console.log(`  ${s.sessions} sessions · ${s.activeDays} active days · ${s.projectCount} projects · ${fmtHM(s.moving)} agent time`);
console.log(`  ${s.toolCalls.toLocaleString('en-US')} tool calls (apportioned by time) · ${s.costCoverage.priced ? 'est. ' + fmtUsd(s.cost) : 'no cost recorded'}` +
  (s.costCoverage.priced < s.costCoverage.of ? ` — ${s.costCoverage.priced} of ${s.costCoverage.of} sessions priced` : ''));
if (s.unbucketed) console.log(`  ${s.unbucketed} session(s) predate daily buckets; filed under their end day`);
console.log(`\n${out.pngPath || out.svgPath}`);
