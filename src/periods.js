// Calendar arithmetic for daily buckets, weeks and months, in local time.
//
// Days are stepped with the Date(y, m, d + 1) constructor rather than by adding
// 24 hours, so a daylight-saving change never shifts a bucket boundary.

const pad = (n) => String(n).padStart(2, '0');

export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const nextMidnight = (ms) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
};

// Credit a stretch of moving time to the local days it covers, splitting it at
// midnight so a late session is not filed entirely under the day it ended.
export function creditInterval(daily, startMs, endMs) {
  let t = startMs;
  while (t < endMs) {
    const stop = Math.min(endMs, nextMidnight(t));
    const k = dayKey(t);
    daily[k] = (daily[k] || 0) + (stop - t);
    t = stop;
  }
}

// ms buckets -> whole seconds, dropping empty days.
export function roundDaily(daily) {
  const out = {};
  for (const [k, ms] of Object.entries(daily || {})) {
    const s = Math.round(ms / 1000);
    if (s > 0) out[k] = s;
  }
  return out;
}

export function addDays(date, n) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

// Monday-first calendar week containing `date`. end is exclusive.
export function weekOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const start = addDays(d, -((d.getDay() + 6) % 7));
  return { start, end: addDays(start, 7), kind: 'week' };
}

export function monthOf(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  return { start, end: new Date(date.getFullYear(), date.getMonth() + 1, 1), kind: 'month' };
}

export function daysIn({ start, end }) {
  const out = [];
  for (let d = start; d < end; d = addDays(d, 1)) out.push(d);
  return out;
}

// "2026-W38" / "2026-09" / "this" / "last" -> bounds.
export function resolvePeriod(kind, spec, now = new Date()) {
  const of = kind === 'week' ? weekOf : monthOf;
  if (!spec || spec === 'this' || spec === 'current') return of(now);
  if (spec === 'last' || spec === 'previous') {
    const cur = of(now);
    return of(kind === 'week' ? addDays(cur.start, -1) : new Date(cur.start.getFullYear(), cur.start.getMonth() - 1, 1));
  }
  if (kind === 'month' && /^\d{4}-\d{2}$/.test(spec)) {
    const [y, m] = spec.split('-').map(Number);
    return monthOf(new Date(y, m - 1, 1));
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(spec)) return of(parseDay(spec));
  throw new Error(`Unrecognised ${kind}: "${spec}". Use this, last, YYYY-MM-DD${kind === 'month' ? ' or YYYY-MM' : ''}.`);
}
