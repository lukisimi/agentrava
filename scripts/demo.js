// Renders a few contrasting cards so layout regressions are obvious.
import { clean } from '../src/metrics.js';
import { badgesFor } from '../src/achievements.js';
import { renderCard } from '../src/card.js';
import { writeCard } from '../src/render.js';
import { renderRecap } from '../src/recap.js';

const SAMPLES = [
  ['demo', { type: 'debug', repo: 'acme/render-service', client: 'claude-code', model: 'Claude Opus 5', athlete: 'Sam Rivera',
    summary: 'Tracked a silent render failure to an orphaned child process and killed it at the source.',
    duration_seconds: 4380, tool_calls: 84, files_changed: 6, lines_added: 341, lines_removed: 512,
    tokens: 612000, tests_passed: 41, errors_recovered: 3, languages: ['JavaScript', 'Shell'] },
    [{ name: 'Biggest Climb' }], 4],
  ['demo-ultra', { type: 'migration', repo: 'acme/monolith', athlete: 'Sam Rivera', client: 'cursor', model: 'Claude Opus 4.8',
    summary: 'Moved 41 services off the legacy queue.', duration_seconds: 12600, tool_calls: 210,
    files_changed: 63, lines_added: 8400, lines_removed: 3100, tokens: 1400000,
    tests_passed: 300, tests_failed: 4, errors_recovered: 5, languages: ['Go', 'SQL', 'Bash'] },
    [{ name: 'Longest Session' }, { name: 'Most Churn' }], 11],
  ['demo-sprint', { type: 'chore', repo: 'acme/web', athlete: 'Sam Rivera', client: 'cursor', model: 'Composer 1.5', summary: 'Bumped a pin, ran the suite, went home.',
    duration_seconds: 140, tool_calls: 6, files_changed: 1, lines_added: 1, lines_removed: 1,
    tokens: 9000, tests_passed: 12, languages: ['JavaScript'] }, [], 1],
];

for (const [name, input, prs, streak] of SAMPLES) {
  const a = clean(input);
  const out = writeCard(name, renderCard(a, { badges: badgesFor(a), prs, streak }));
  console.log(out.pngPath, '—', badgesFor(a).map((b) => b.name).join(', ') || '(no badges)');
}

/* ---------- a synthetic season, so the README never publishes real telemetry ---------- */

// Deterministic, so the committed example only changes when this code does.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const TYPES = ['feature', 'refactor', 'debug', 'review', 'test', 'migration', 'research', 'chore'];
const LANGS = [['TypeScript', 'CSS'], ['Go', 'SQL'], ['Python'], ['Rust', 'TOML'],
               ['JavaScript', 'HTML', 'CSS'], ['Ruby', 'SQL', 'Shell']];

function fakeSeason(n = 140) {
  const r = rng(20260904);
  const out = [];
  const end = new Date('2026-09-04T18:00:00Z');
  for (let i = 0; i < n; i++) {
    const daysAgo = Math.floor(r() * 190);
    const d = new Date(end.getTime() - daysAgo * 86400000);
    // Cluster the clock the way real work does: a daytime hump, a late-night tail.
    const hour = r() < 0.18 ? Math.floor(r() * 5) : 9 + Math.floor(r() * 11);
    d.setHours(hour, Math.floor(r() * 60), 0, 0);
    if (d.getDay() === 0 && r() < 0.75) continue;          // quiet weekends
    const heavy = r() < 0.2;
    const a = clean({
      date: d.toISOString(),
      type: TYPES[Math.floor(r() * TYPES.length)],
      athlete: 'Sam Rivera',
      client: r() < 0.5 ? 'claude-code' : 'cursor',
      repo: ['acme/render-service', 'acme/api', 'acme/web'][Math.floor(r() * 3)],
      duration_seconds: Math.round((heavy ? 3600 + r() * 18000 : 300 + r() * 5400)),
      tool_calls: Math.round(heavy ? 150 + r() * 500 : 12 + r() * 130),
      files_changed: Math.round(r() * (heavy ? 40 : 8)),
      lines_added: Math.round(r() * (heavy ? 900 : 160)),
      lines_removed: Math.round(r() * (heavy ? 400 : 90)),
      tokens: Math.round((heavy ? 2e6 + r() * 6e6 : 1e5 + r() * 1.2e6)),
      errors_recovered: Math.round(r() * (heavy ? 9 : 3)),
      tests_passed: Math.round(r() * 40),
      languages: LANGS[Math.floor(r() * LANGS.length)],
    });
    // The recap reads badges off the stored activity, so award them here too.
    a.badges = badgesFor(a).map((b) => b.id);
    out.push(a);
  }
  return out;
}

const season = fakeSeason();
const recap = writeCard('demo-recap', renderRecap(season, { athlete: 'Sam Rivera' }));
console.log(recap.pngPath, `— synthetic recap, ${season.length} activities`);
