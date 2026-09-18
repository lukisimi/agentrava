// API list prices, USD per million tokens. Both vendors bill cache writes at
// 1.25x input and cache reads at 0.1x input, so one table shape covers them.
//
// IMPORTANT: this is what a session would have cost at list price on the API.
// Claude Code and Codex on a subscription do not bill per token, so treat the
// figure as a size comparison between sessions, not an invoice.
//
// OpenAI rates read from developers.openai.com/api/docs/pricing, 18 September
// 2026. gpt-5.6-sol's is promotional at least through 21 November 2026.
const RATES = {
  'claude-fable-5-1': [10, 50], 'claude-fable-5': [10, 50],
  'claude-mythos-5-1': [10, 50], 'claude-mythos-5': [10, 50],
  'claude-opus-5': [5, 25], 'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25], 'claude-opus-4-6': [5, 25],
  'claude-sonnet-5': [2, 10], 'claude-sonnet-4-6': [3, 15],
  'claude-haiku-4-5': [1, 5],
  'gpt-6-astra': [10, 50],
  'gpt-5.6-sol': [4, 20], 'gpt-5.6-terra': [2, 12], 'gpt-5.6-luna': [0.2, 1.2],
  'gpt-5.6-cyber': [12.5, 75], 'gpt-5.3-codex': [1.75, 14],
  'chat-latest': [5, 30],
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
  if (/^gpt-6/.test(id)) return [10, 50];
  if (/^gpt-5\.6/.test(id)) return [4, 20];
  // Anything else — Codex's own codex-auto-review, a model released since this
  // table was written — is left unpriced rather than guessed at.
  return null;
}

// OpenAI charges a whole request at 2x input and 1.5x output once its prompt
// passes 272K input tokens. Callers that can see per-request sizes pass
// longContext for those requests; the default is the ordinary tier.
const LONG_IN = 2, LONG_OUT = 1.5;

export function costOf({ model, input = 0, output = 0, cacheWrite = 0, cacheRead = 0, longContext = false }) {
  const r = rate(model);
  if (!r) return null;
  const inRate = r[0] * (longContext ? LONG_IN : 1);
  const outRate = r[1] * (longContext ? LONG_OUT : 1);
  return (input * inRate + cacheWrite * inRate * CACHE_WRITE
        + cacheRead * inRate * CACHE_READ + output * outRate) / 1e6;
}

export const LONG_CONTEXT_TOKENS = 272_000;

export function fmtUsd(v) {
  if (v == null) return '—';
  if (v >= 100) return '$' + Math.round(v);
  if (v >= 10) return '$' + v.toFixed(1);
  if (v >= 0.01) return '$' + v.toFixed(2);
  return '<$0.01';
}
