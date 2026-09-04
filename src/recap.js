// Season recap: one card summarising every logged activity in a period.
import { C, esc, charW, fit } from './card.js';
import { derive, fmtDuration, fmtNum } from './metrics.js';

const W = 1080, H = 1560, P = 64;
const ACCENT = C.brand;
const DAY_MS = 86400000;

const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function summarise(acts) {
  const t = { km: 0, m: 0, sec: 0, tokens: 0, calls: 0, files: 0, added: 0, removed: 0, errors: 0 };
  const byDay = new Map();      // yyyy-mm-dd -> km
  const byHour = Array(24).fill(0);
  const badges = new Map();
  let best = null;

  for (const a of acts) {
    const d = derive(a);
    t.km += d.distance_km; t.m += d.elevation_m; t.sec += a.duration_seconds;
    t.tokens += a.tokens; t.calls += a.tool_calls; t.files += a.files_changed;
    t.added += a.lines_added; t.removed += a.lines_removed; t.errors += a.errors_recovered;

    const dt = new Date(a.date);
    byDay.set(iso(dt), (byDay.get(iso(dt)) || 0) + d.distance_km);
    byHour[dt.getHours()]++;
    for (const b of a.badges || []) badges.set(b, (badges.get(b) || 0) + 1);
    if (!best || d.distance_km > derive(best).distance_km) best = a;
  }
  return { t, byDay, byHour, badges, best };
}

// Longest run of consecutive active days in the period (not the live streak).
function longestStreak(byDay) {
  const days = [...byDay.keys()].sort();
  let best = 0, run = 0, prev = null;
  for (const d of days) {
    const cur = Date.parse(d + 'T00:00:00Z');
    run = prev !== null && cur - prev === DAY_MS ? run + 1 : 1;
    prev = cur;
    if (run > best) best = run;
  }
  return best;
}

function bigStat(x, y, value, unit, label) {
  const vw = value.length * charW(62, true);
  return `<text x="${x}" y="${y}" fill="${C.ink}" font-size="62" font-weight="700" letter-spacing="-1">${esc(value)}</text>` +
    (unit ? `<text x="${(x + vw + 8).toFixed(0)}" y="${y}" fill="${C.muted}" font-size="24" font-weight="600">${esc(unit)}</text>` : '') +
    `<text x="${x}" y="${y + 33}" fill="${C.dim}" font-size="18" font-weight="600" letter-spacing="1.6">${esc(label.toUpperCase())}</text>`;
}
function smallStat(x, y, value, label) {
  return `<text x="${x}" y="${y}" fill="${C.ink}" font-size="34" font-weight="700">${esc(value)}</text>` +
    `<text x="${x}" y="${y + 26}" fill="${C.dim}" font-size="16" font-weight="600" letter-spacing="1.3">${esc(label.toUpperCase())}</text>`;
}
const sectionLabel = (x, y, s) =>
  `<text x="${x}" y="${y}" fill="${C.dim}" font-size="17" font-weight="700" letter-spacing="2">${esc(s)}</text>`;

export function renderRecap(activities, { athlete = 'Claude', title = '' } = {}) {
  const acts = activities.slice().sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  if (!acts.length) throw new Error('No activities to recap.');
  const { t, byDay, byHour, badges, best } = summarise(acts);

  const from = new Date(acts[0].date), to = new Date(acts[acts.length - 1].date);
  const fmtD = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  const period = `${fmtD(from)} – ${fmtD(to)} ${to.getFullYear()}`;

  /* ---------- calendar heatmap: one column per week, Monday at the top ---------- */
  const gutter = 52;
  const gridX = P + gutter, gridY = 620;
  const start = new Date(from); start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));          // back to Monday
  const weeks = Math.max(1, Math.ceil((to - start) / (7 * DAY_MS)) + 1);
  const colW = Math.max(12, Math.min(58, Math.floor((W - 2 * P - gutter) / weeks)));
  const cell = colW - 6;
  const maxKm = Math.max(...byDay.values(), 1);

  let cells = '', monthLabels = '', lastMonth = -1;
  for (let w = 0; w < weeks; w++) {
    for (let dow = 0; dow < 7; dow++) {
      const day = new Date(start.getTime() + (w * 7 + dow) * DAY_MS);
      if (day > to || day < from) {
        // Still draw the empty slot so the grid reads as a calendar.
        cells += `<rect x="${gridX + w * colW}" y="${gridY + dow * colW}" width="${cell}" height="${cell}" rx="4" fill="#ffffff" fill-opacity="0.03"/>`;
        continue;
      }
      const km = byDay.get(iso(day)) || 0;
      const op = km === 0 ? 0.05 : 0.22 + 0.78 * Math.sqrt(km / maxKm);
      cells += `<rect x="${gridX + w * colW}" y="${gridY + dow * colW}" width="${cell}" height="${cell}" rx="4" fill="${km ? ACCENT : '#ffffff'}" fill-opacity="${op.toFixed(3)}"/>`;
      if (dow === 3 && day.getMonth() !== lastMonth) {
        lastMonth = day.getMonth();
        monthLabels += `<text x="${gridX + w * colW}" y="${gridY - 14}" fill="${C.dim}" font-size="15" font-weight="600">${MONTHS[lastMonth]}</text>`;
      }
    }
  }
  const dowLabels = ['M', 'W', 'F'].map((s, i) =>
    `<text x="${P + 8}" y="${gridY + [0, 2, 4][i] * colW + cell / 2 + 5}" fill="${C.dim}" font-size="14" font-weight="600">${s}</text>`).join('');
  const gridBottom = gridY + 7 * colW;

  /* ---------- hour-of-day histogram ---------- */
  const histY = gridBottom + 96, histH = 118, histW = W - 2 * P;
  const barW = histW / 24, maxHour = Math.max(...byHour, 1);
  const bars = byHour.map((n, h) => {
    const bh = n ? Math.max(3, (n / maxHour) * histH) : 2;
    return `<rect x="${(P + h * barW + 3).toFixed(1)}" y="${(histY + histH - bh).toFixed(1)}" width="${(barW - 6).toFixed(1)}" height="${bh.toFixed(1)}" rx="3" fill="${ACCENT}" fill-opacity="${n ? 0.85 : 0.12}"/>`;
  }).join('');
  const hourTicks = [0, 6, 12, 18, 23].map((h) =>
    `<text x="${(P + h * barW + barW / 2).toFixed(1)}" y="${histY + histH + 24}" fill="${C.dim}" font-size="14" text-anchor="middle">${h}:00</text>`).join('');
  const peak = byHour.indexOf(Math.max(...byHour));
  const night = byHour.slice(23).concat(byHour.slice(0, 5)).reduce((a, b) => a + b, 0);

  /* ---------- trophy chips ---------- */
  const top = [...badges.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  let chipX = P; const chipY = histY + histH + 96;
  let chips = '';
  for (const [id, n] of top) {
    const label = fit(id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) + ` ×${n}`, 20, 300, true);
    const w = Math.ceil(label.length * charW(20, true)) + 42;
    if (chipX + w > W - P) break;               // measure before drawing, not after
    chips += `<g><rect x="${chipX}" y="${chipY}" rx="25" ry="25" width="${w}" height="50" fill="${C.panel2}"/>` +
      `<text x="${chipX + w / 2}" y="${chipY + 32}" fill="${C.ink}" font-size="20" font-weight="700" text-anchor="middle">${esc(label)}</text></g>`;
    chipX += w + 10;
  }

  const bestD = derive(best);
  const streakDays = longestStreak(byDay);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">
    <stop offset="0" stop-color="${C.bg1}"/><stop offset="1" stop-color="${C.bg0}"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect x="0" y="0" width="${W}" height="8" fill="${ACCENT}"/>

  <text x="${P}" y="${96}" fill="${ACCENT}" font-size="26" font-weight="700" letter-spacing="4">AGENTRAVA</text>
  <text x="${W - P}" y="${96}" fill="${C.muted}" font-size="21" text-anchor="end">${esc(period)}</text>

  <text x="${P}" y="${196}" fill="${C.ink}" font-size="58" font-weight="700" letter-spacing="-1.2">${esc(title || `${acts.length} Activities`)}</text>
  <text x="${P}" y="${238}" fill="${C.muted}" font-size="23">${esc(`${athlete}  ·  ${byDay.size} active days  ·  longest streak ${streakDays} day${streakDays === 1 ? '' : 's'}`)}</text>

  ${bigStat(P, 350, t.km.toFixed(0), 'km', 'Distance')}
  ${bigStat(P + 322, 350, fmtNum(Math.round(t.m)), 'm', 'Elevation')}
  ${bigStat(P + 644, 350, fmtDuration(t.sec).split(':')[0], 'h', 'Moving Time')}

  <line x1="${P}" y1="${412}" x2="${W - P}" y2="${412}" stroke="#ffffff" stroke-opacity="0.08"/>

  ${smallStat(P, 480, String(acts.length), 'Activities')}
  ${smallStat(P + 246, 480, fmtNum(t.calls), 'Tool calls')}
  ${smallStat(P + 492, 480, fmtNum(t.tokens), 'Tokens')}
  ${smallStat(P + 738, 480, `+${fmtNum(t.added)} / −${fmtNum(t.removed)}`, 'Lines')}

  ${sectionLabel(P, gridY - 46, 'ACTIVITY')}
  ${monthLabels}${dowLabels}${cells}

  ${sectionLabel(P, histY - 26, 'WHEN YOU WORK')}
  <text x="${W - P}" y="${histY - 26}" fill="${C.muted}" font-size="17" text-anchor="end">${esc(`peak ${peak}:00  ·  ${night} sessions between 23:00 and 05:00`)}</text>
  ${bars}${hourTicks}

  ${sectionLabel(P, chipY - 24, 'TROPHY CASE')}
  ${chips}

  <line x1="${P}" y1="${H - 132}" x2="${W - P}" y2="${H - 132}" stroke="#ffffff" stroke-opacity="0.08"/>
  <text x="${P}" y="${H - 86}" fill="${C.dim}" font-size="16" font-weight="600" letter-spacing="1.4">BIGGEST SESSION</text>
  <text x="${P}" y="${H - 54}" fill="${C.ink}" font-size="24" font-weight="700">${esc(fit(`${best.title} — ${bestD.distance_km.toFixed(1)} km, ${fmtDuration(best.duration_seconds)}`, 24, 700, true))}</text>
  <text x="${W - P}" y="${H - 86}" fill="${C.dim}" font-size="16" font-weight="600" letter-spacing="1.4" text-anchor="end">ERRORS CLIMBED</text>
  <text x="${W - P}" y="${H - 54}" fill="${ACCENT}" font-size="24" font-weight="700" text-anchor="end">${esc(String(t.errors))}</text>
</svg>`;
}
