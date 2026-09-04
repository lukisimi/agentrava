// Who actually did the work. Both clients record the model per message, so the
// athlete is measured rather than assumed — a Cursor session driven by Grok
// should not be filed under Claude.

const GENERIC = new Set(['default', 'auto', 'premium', 'unknown', '<synthetic>', '2', '1']);

const FAMILY = [
  [/\bopus\b/i, 'Opus'], [/\bsonnet\b/i, 'Sonnet'], [/\bhaiku\b/i, 'Haiku'],
];

export function prettyModel(id) {
  if (!id) return null;
  const s = String(id).trim().toLowerCase();
  if (!s || GENERIC.has(s)) return null;

  if (s.startsWith('claude')) {
    const fam = (FAMILY.find(([re]) => re.test(s)) || [, null])[1];
    // Versions appear as opus-5, opus-4-8 or 4.6-sonnet; normalise to 4.8 / 5.
    const v = s.match(/(\d+(?:[.-]\d+)?)/g)?.find((x) => !/^\d{4}$/.test(x));
    const ver = v ? v.replace('-', '.') : null;
    return ['Claude', fam, ver].filter(Boolean).join(' ');
  }
  if (s.startsWith('gpt')) {
    const m = s.match(/gpt-?([\d.]+)/);
    return 'GPT-' + (m ? m[1] : '').replace(/\.$/, '') + (s.includes('codex') ? ' Codex' : '');
  }
  if (s.startsWith('grok')) return 'Grok ' + (s.match(/([\d.]+)/)?.[1] || '');
  if (s.startsWith('composer')) return 'Composer ' + (s.match(/([\d.]+)/)?.[1] || '');
  if (s.startsWith('gemini')) return 'Gemini ' + (s.match(/([\d.]+)/)?.[1] || '');
  if (s.startsWith('o1') || s.startsWith('o3') || s.startsWith('o4')) return s.toUpperCase();
  // Unrecognised: title-case it rather than guess a vendor.
  return s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

// The model that produced most of the session's messages.
export function dominantModel(counts) {
  let best = null, n = 0;
  for (const [id, c] of Object.entries(counts || {})) {
    const pretty = prettyModel(id);
    if (pretty && c > n) { best = pretty; n = c; }
  }
  return best;
}
