// Renders a few contrasting cards so layout regressions are obvious.
import { clean } from '../src/metrics.js';
import { badgesFor } from '../src/achievements.js';
import { renderCard } from '../src/card.js';
import { writeCard } from '../src/render.js';

const SAMPLES = [
  ['demo', { type: 'debug', repo: 'acme/render-service',
    summary: 'Tracked a silent render failure to an orphaned child process and killed it at the source.',
    duration_seconds: 4380, tool_calls: 84, files_changed: 6, lines_added: 341, lines_removed: 512,
    tokens: 612000, tests_passed: 41, errors_recovered: 3, languages: ['JavaScript', 'Shell'] },
    [{ name: 'Biggest Climb' }], 4],
  ['demo-ultra', { type: 'migration', repo: 'acme/monolith', athlete: 'Claude',
    summary: 'Moved 41 services off the legacy queue.', duration_seconds: 12600, tool_calls: 210,
    files_changed: 63, lines_added: 8400, lines_removed: 3100, tokens: 1400000,
    tests_passed: 300, tests_failed: 4, errors_recovered: 5, languages: ['Go', 'SQL', 'Bash'] },
    [{ name: 'Longest Session' }, { name: 'Most Churn' }], 11],
  ['demo-sprint', { type: 'chore', repo: 'agentrava', summary: 'Bumped a pin, ran the suite, went home.',
    duration_seconds: 140, tool_calls: 6, files_changed: 1, lines_added: 1, lines_removed: 1,
    tokens: 9000, tests_passed: 12, languages: ['JavaScript'] }, [], 1],
];

for (const [name, input, prs, streak] of SAMPLES) {
  const a = clean(input);
  const out = writeCard(name, renderCard(a, { badges: badgesFor(a), prs, streak }));
  console.log(out.pngPath, '—', badgesFor(a).map((b) => b.name).join(', ') || '(no badges)');
}
