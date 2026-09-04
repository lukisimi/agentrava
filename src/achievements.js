import fs from 'node:fs';
import path from 'node:path';
import { derive } from './metrics.js';
import { HOME } from './store.js';

// Each badge is a claim about the session that a human could check.
// Keep them earnable — a card where everything lights up brags about nothing.
const BADGES = [
  { id: 'negative_splits', name: 'Negative Splits', blurb: 'Deleted more than you wrote',
    test: (a, d) => d.net_lines < 0 && d.churn >= 100 },
  { id: 'flawless', name: 'Flawless', blurb: 'No errors, no failed tests',
    test: (a) => a.errors_recovered === 0 && a.tests_failed === 0 && a.tool_calls >= 10 },
  { id: 'hill_repeats', name: 'Hill Repeats', blurb: 'Climbed out of it 3+ times',
    test: (a) => a.errors_recovered >= 3 },
  { id: 'marathon', name: 'Marathon', blurb: 'Over an hour of moving time',
    test: (a) => a.duration_seconds >= 3600 },
  { id: 'ultra', name: 'Ultra', blurb: 'Three hours. Go outside.',
    test: (a) => a.duration_seconds >= 10800 },
  { id: 'sprint', name: 'Sprint', blurb: 'In and out under 3 minutes',
    test: (a) => a.duration_seconds <= 180 && a.files_changed >= 1 },
  { id: 'yak_shave', name: 'Yak Shave', blurb: '30+ tool calls, barely a diff',
    test: (a) => a.tool_calls >= 30 && a.files_changed <= 2 },
  { id: 'all_green', name: 'All Green', blurb: 'Full suite, zero red',
    test: (a) => a.tests_passed >= 5 && a.tests_failed === 0 },
  { id: 'furnace', name: 'Furnace', blurb: 'Five million tokens burned',
    test: (a) => a.tokens >= 5_000_000 },
  { id: 'nocturnal', name: 'Nocturnal', blurb: 'Logged between 11pm and 5am',
    test: (a) => { const h = new Date(a.date).getHours(); return h >= 23 || h < 5; } },
  { id: 'everest', name: 'Everest', blurb: '3000m+ of elevation',
    test: (a, d) => d.elevation_m >= 3000 },
  { id: 'ten_k', name: '10K Club', blurb: 'Ten kilometres of ground covered',
    test: (a, d) => d.distance_km >= 10 },
  { id: 'gran_fondo', name: 'Gran Fondo', blurb: '40 km. A long day out.',
    test: (a, d) => d.distance_km >= 40 },
  { id: 'polyglot', name: 'Polyglot', blurb: 'Three or more languages',
    test: (a) => a.languages.length >= 3 },
  { id: 'red_zone', name: 'Red Zone', blurb: 'Effort score 90+',
    test: (a, d) => d.effort >= 90 },
  // Cursor records whether the human kept each edit — the only outcome signal in
  // any transcript. Earned by 9% of Cursor sessions.
  { id: 'signed_off', name: 'Signed Off', blurb: '10+ edits accepted, none sent back',
    test: (a) => a.edits_accepted >= 10 && a.edits_rejected === 0 },
  { id: 'sightseeing', name: 'Sightseeing', blurb: 'All that reading, no writing',
    test: (a) => a.tool_calls >= 15 && a.files_changed === 0 && a.lines_added === 0 },
];

export function badgesFor(a) {
  const d = derive(a);
  return BADGES.filter((b) => { try { return b.test(a, d); } catch { return false; } })
               .map(({ id, name, blurb }) => ({ id, name, blurb }));
}

const RECORDS = [
  { id: 'longest',   name: 'Longest Session',  unit: 'time',  get: (a) => a.duration_seconds },
  { id: 'distance',  name: 'Most Churn',       unit: 'km',    get: (a) => derive(a).distance_km },
  { id: 'elevation', name: 'Biggest Climb',    unit: 'm',     get: (a) => derive(a).elevation_m },
  { id: 'cadence',   name: 'Highest Cadence',  unit: 'tpm',   get: (a) => derive(a).cadence },
  { id: 'effort',    name: 'Hardest Effort',   unit: '',      get: (a) => derive(a).effort },
];

// A PR only counts if there was something to beat.
export function prsFor(activity, history) {
  const prior = history.filter((h) => h.id !== activity.id);
  if (!prior.length) return [];
  return RECORDS.filter((r) => {
    const v = r.get(activity);
    return v > 0 && v > Math.max(...prior.map(r.get));
  }).map(({ id, name, unit }) => ({ id, name, unit }));
}

// Stored activities keep only record ids; this maps them back to display names.
export const RECORD_NAMES = Object.fromEntries(RECORDS.map((r) => [r.id, r.name]));

// Days the day-stamp hook recorded, if it is installed. Cheap to read; the file
// gains one line a day.
export function stampedDays() {
  try {
    return fs.readFileSync(path.join(HOME, 'days.txt'), 'utf8')
      .split('\n').filter(Boolean)
      .map((d) => new Date(d + 'T12:00:00').toDateString());
  } catch { return []; }
}

export function streak(history) {
  // Union of days with a logged activity and days the stamp hook saw, so the
  // streak means "days I used the tool" rather than "days I remembered to log".
  const days = new Set([...history.map((a) => new Date(a.date).toDateString()), ...stampedDays()]);
  let n = 0;
  const cur = new Date();
  // Today not yet logged is fine — a streak can still be alive from yesterday.
  if (!days.has(cur.toDateString())) cur.setDate(cur.getDate() - 1);
  while (days.has(cur.toDateString())) { n++; cur.setDate(cur.getDate() - 1); }
  return n;
}
