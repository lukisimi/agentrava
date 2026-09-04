// API list prices, USD per million tokens. Cache writes bill at 1.25x input and
// cache reads at 0.1x input.
//
// IMPORTANT: this is what a session would have cost on the Claude API at list
// price. Claude Code on a subscription does not bill per token, so treat the
// figure as a size comparison between sessions, not an invoice.
const RATES = {
  'claude-fable-5-1': [10, 50], 'claude-fable-5': [10, 50],
  'claude-mythos-5-1': [10, 50], 'claude-mythos-5': [10, 50],
  'claude-opus-5': [5, 25], 'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25], 'claude-opus-4-6': [5, 25],
  'claude-sonnet-5': [2, 10], 'claude-sonnet-4-6': [3, 15],
  'claude-haiku-4-5': [1, 5],
};
const CACHE_WRITE = 1.25;
const CACHE_READ = 0.1;

// Match on family so an unrecognised variant still prices sensibly.
function rate(model) {
  if (!model) return null;
  const id = String(model).toLowerCase();
  if (RATES[id]) return RATES[id];
  for (const [k, v] of Object.entries(RATES)) if (id.startsWith(k)) return v;
  if (/fable|mythos/.test(id)) return [10, 50];
  if (/opus/.test(id)) return [5, 25];
  if (/sonnet/.test(id)) return [2, 10];
  if (/haiku/.test(id)) return [1, 5];
  return null;
}

export function costOf({ model, input = 0, output = 0, cacheWrite = 0, cacheRead = 0 }) {
  const r = rate(model);
  if (!r) return null;
  const [inRate, outRate] = r;
  return (input * inRate + cacheWrite * inRate * CACHE_WRITE
        + cacheRead * inRate * CACHE_READ + output * outRate) / 1e6;
}

export function fmtUsd(v) {
  if (v == null) return '—';
  if (v >= 100) return '$' + Math.round(v);
  if (v >= 10) return '$' + v.toFixed(1);
  if (v >= 0.01) return '$' + v.toFixed(2);
  return '<$0.01';
}
