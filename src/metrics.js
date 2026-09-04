// The Strava metaphor lives here: raw session numbers in, athletic-sounding
// derived stats out. Nothing else in the codebase should invent a formula.

export const ACTIVITY_TYPES = {
  feature:   { verb: 'Build',     icon: 'run',  color: '#fc5200' },
  refactor:  { verb: 'Refactor',  icon: 'ride', color: '#f7a600' },
  debug:     { verb: 'Debug',     icon: 'hike', color: '#e0245e' },
  review:    { verb: 'Review',    icon: 'walk', color: '#5b8def' },
  test:      { verb: 'Test Run',  icon: 'run',  color: '#26c281' },
  migration: { verb: 'Migration', icon: 'ride', color: '#9b59b6' },
  research:  { verb: 'Recon',     icon: 'walk', color: '#00b8d9' },
  chore:     { verb: 'Chore Lap', icon: 'walk', color: '#8a94a6' },
};

const TIME_OF_DAY = [
  [5, 'Early Morning'], [8, 'Morning'], [11, 'Lunchtime'], [14, 'Afternoon'],
  [17, 'Evening'], [21, 'Night'], [24, 'Late Night'],
];

export function autoTitle(type, date = new Date()) {
  const h = date.getHours();
  const when = h < 5 ? 'Late Night' : (TIME_OF_DAY.find(([cut]) => h < cut) || [, 'Night'])[1];
  const verb = (ACTIVITY_TYPES[type] || ACTIVITY_TYPES.feature).verb;
  return `${when} ${verb}`;
}

export function clean(input = {}) {
  const n = (v, d = 0) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  const type = ACTIVITY_TYPES[input.type] ? input.type : 'feature';
  const at = input.date ? new Date(input.date) : new Date();
  return {
    id: 'act_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    date: (isNaN(at) ? new Date() : at).toISOString(),
    type,
    title: (input.title || '').trim() || autoTitle(type, isNaN(at) ? new Date() : at),
    summary: (input.summary || '').trim().slice(0, 160),
    athlete: (input.athlete || 'Claude').trim().slice(0, 40),
    repo: (input.repo || '').trim().slice(0, 60),
    duration_seconds: n(input.duration_seconds, 60),
    tool_calls: n(input.tool_calls),
    files_changed: n(input.files_changed),
    lines_added: n(input.lines_added),
    lines_removed: n(input.lines_removed),
    tokens: n(input.tokens),
    tests_passed: n(input.tests_passed),
    tests_failed: n(input.tests_failed),
    errors_recovered: n(input.errors_recovered),
    edits_accepted: n(input.edits_accepted),
    edits_rejected: n(input.edits_rejected),
    languages: (Array.isArray(input.languages) ? input.languages : []).slice(0, 6).map(String),
    notes: (Array.isArray(input.notes) ? input.notes : []).slice(0, 4).map((s) => String(s).slice(0, 80)),
    photo: input.photo ? String(input.photo) : undefined,
  };
}

// Derived athletics. Distance is ground covered: 100 changed lines = 1 km, plus
// 1 km per 25 tool calls, because reading and searching is distance too.
// (Calibrated against real sessions: churn alone left the median session at
// 0.00 km, since most sessions investigate far more than they write.)
// Elevation is the stuff that actually hurt: files touched, errors climbed out of.
export function derive(a) {
  const churn = a.lines_added + a.lines_removed;
  const distance_km = churn / 100 + a.tool_calls / 25;
  const elevation_m = a.files_changed * 37 + a.errors_recovered * 120 + a.tests_failed * 45;
  const minutes = Math.max(a.duration_seconds / 60, 1 / 60);
  const pace_min_per_km = distance_km > 0 ? minutes / distance_km : 0;
  const cadence = a.tool_calls / minutes;           // tool calls per minute
  // Weights fitted to a real session distribution so the median lands near 30
  // and the score only saturates for genuinely brutal sessions.
  const effort = Math.min(100, Math.round(
    (cadence * 6) + (elevation_m / 80) + (a.tokens / 200_000) + (a.errors_recovered * 3)
  ));
  return {
    churn,
    distance_km,
    elevation_m,
    pace_min_per_km,
    cadence,
    effort,                                          // "suffer score", 0-100
    net_lines: a.lines_added - a.lines_removed,
    tokens_per_min: a.tokens / minutes,
  };
}

export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtPace(minPerKm) {
  if (!minPerKm || !Number.isFinite(minPerKm)) return '—';
  if (minPerKm > 99) return '99+';
  const m = Math.floor(minPerKm), s = Math.round((minPerKm - m) * 60);
  return `${s === 60 ? m + 1 : m}:${String(s === 60 ? 0 : s).padStart(2, '0')}`;
}

export function fmtNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 10_000) return Math.round(n / 1000) + 'k';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}
