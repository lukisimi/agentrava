// One aggregation for every period card, kept apart from drawing.
//
// Time comes from each activity's daily buckets, so a session that crosses a
// period boundary is counted in both and its time apportioned. Tool calls and
// cost have no per-day record; they are apportioned by the same time share and
// labelled as such. Activities logged before buckets existed fall back to their
// end date, and the summary says how many did.
import { dayKey, daysIn } from './periods.js';
import { badgesFor } from './achievements.js';

export function summarize(activities, period, { pick = null, now = new Date() } = {}) {
  const days = daysIn(period).map((date) => ({ key: dayKey(date.getTime()), date, seconds: 0, sessions: 0 }));
  const byKey = new Map(days.map((d) => [d.key, d]));
  const sessions = [];
  let unbucketed = 0;

  for (const a of activities) {
    const perDay = [];
    let inRange = 0, total = 0;
    const buckets = a.daily && Object.keys(a.daily).length ? a.daily : null;
    if (buckets) {
      for (const [k, sec] of Object.entries(buckets)) {
        total += sec;
        const day = byKey.get(k);
        if (day) { inRange += sec; perDay.push([day, sec]); }
      }
    } else {
      total = a.duration_seconds || 0;
      const day = byKey.get(dayKey(Date.parse(a.date)));
      if (day && total) { inRange = total; perDay.push([day, total]); }
    }
    if (inRange <= 0) continue;
    if (!buckets) unbucketed++;
    for (const [day, sec] of perDay) { day.seconds += sec; day.sessions++; }
    sessions.push({ a, seconds: inRange, share: total > 0 ? inRange / total : 1 });
  }

  const moving = sessions.reduce((n, s) => n + s.seconds, 0);
  const toolCalls = Math.round(sessions.reduce((n, s) => n + (s.a.tool_calls || 0) * s.share, 0));
  const priced = sessions.filter((s) => s.a.cost_usd > 0);
  const cost = priced.reduce((n, s) => n + s.a.cost_usd * s.share, 0);

  // Grouped by identity (repository path), so two projects sharing a display name
  // stay two bars. Pass activities through presentAll() to get renamed names.
  const projectTime = new Map();
  for (const s of sessions) {
    const id = s.a.project_id || (s.a.repo ? `name:${s.a.repo}` : null);
    if (!id) continue;
    const cur = projectTime.get(id) || { id, name: s.a.project_name || s.a.repo, hidden: Boolean(s.a.project_hidden), seconds: 0 };
    cur.seconds += s.seconds;
    projectTime.set(id, cur);
  }
  const projects = [...projectTime.values()].sort((x, y) => y.seconds - x.seconds);

  const ranked = sessions.slice().sort((x, y) => y.seconds - x.seconds);
  const longest = ranked[0] || null;

  // A pick is only "selected" if one was actually given and it falls in range.
  let picked = null;
  if (pick) {
    picked = sessions.find((s) => s.a.id === pick || (s.a.session_id || '').startsWith(pick)) || null;
  }
  const feature = picked || longest;

  return {
    period,
    partial: now >= period.start && now < period.end,
    days,
    sessions: sessions.length,
    activeDays: days.filter((d) => d.seconds > 0).length,
    projectCount: projects.length,
    projects,
    moving,
    toolCalls,
    cost,
    costCoverage: { priced: priced.length, of: sessions.length },
    feature: feature && {
      activity: feature.a,
      seconds: feature.seconds,
      selected: Boolean(picked),
      badges: badgesFor(feature.a).slice(0, 3),
    },
    unbucketed,
  };
}

export function fmtHM(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}
