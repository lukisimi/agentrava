// Weekly and Monthly Snap: period summaries at the same 1080×1350 as a session
// card, so a snap and a card sit side by side in a feed without either being
// cropped. The mockups were roughly twice as tall; everything here is budgeted
// to fit that frame, including a six-row month.
import { C, esc, charW, fit } from './card.js';
import { fmtUsd } from './pricing.js';
import { fmtHM } from './summary.js';
import { config } from './store.js';

const W = 1080, H = 1350, P = 64;
const ACCENT = '#ff3b7f';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const DOW = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

/* ---------------- shared pieces ---------------- */

function frame(inner, { athlete, sub, kind, partial }) {
  const initial = esc((athlete || 'A').slice(0, 1).toUpperCase());
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="${C.bg1}"/><stop offset="1" stop-color="${C.bg0}"/></linearGradient>
    <linearGradient id="bar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${ACCENT}"/><stop offset="1" stop-color="${ACCENT}" stop-opacity="0.45"/></linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="8" fill="${ACCENT}"/>
  <circle cx="${P + 33}" cy="103" r="33" fill="${ACCENT}" fill-opacity="0.18" stroke="${ACCENT}" stroke-opacity="0.5" stroke-width="2"/>
  <text x="${P + 33}" y="114" fill="${ACCENT}" font-size="32" font-weight="700" text-anchor="middle">${initial}</text>
  <text x="${P + 84}" y="95" fill="${C.ink}" font-size="29" font-weight="700">${esc(fit(athlete, 29, 470, true))}</text>
  <text x="${P + 84}" y="127" fill="${C.muted}" font-size="21">${esc(sub)}</text>
  <text x="${W - P}" y="98" fill="${C.label}" font-size="19" font-weight="700" letter-spacing="2" text-anchor="end">${kind}</text>
  ${partial ? `<text x="${W - P}" y="127" fill="${ACCENT}" font-size="18" font-weight="700" letter-spacing="1.5" text-anchor="end">${partial}</text>` : ''}
  ${inner}
  <line x1="${P}" y1="1252" x2="${W - P}" y2="1252" stroke="#ffffff" stroke-opacity="0.08"/>
  <text x="${P}" y="1302" fill="${C.brand}" font-size="30" font-weight="700" letter-spacing="4">AGENTRAVA</text>
  <text x="${W - P}" y="1302" fill="${C.label}" font-size="19" text-anchor="end">Recorded activity · Not a productivity score</text>
</svg>`;
}

const label = (x, y, s, anchor = 'start') =>
  `<text x="${x}" y="${y}" fill="${C.label}" font-size="17" font-weight="700" letter-spacing="2" text-anchor="${anchor}">${esc(s)}</text>`;

function headline(y, items, size = 68) {
  const col = (W - 2 * P) / items.length;
  return items.map(([value, name], i) => `
  <text x="${P + i * col}" y="${y}" fill="${C.ink}" font-size="${size}" font-weight="700" letter-spacing="-1.5">${esc(value)}</text>
  <text x="${P + i * col}" y="${y + 36}" fill="${C.label}" font-size="18" font-weight="600" letter-spacing="2">${esc(name.toUpperCase())}</text>`).join('');
}

function chips(x, y, badges, h = 52) {
  let out = '';
  const mid = h / 2;
  for (const b of badges) {
    const w = Math.ceil(b.name.length * charW(21, true)) + 78;
    if (x + w > W - P) break;
    out += `<g><rect x="${x}" y="${y}" rx="${mid}" width="${w}" height="${h}" fill="${C.panel2}"/>
    <circle cx="${x + 30}" cy="${y + mid}" r="14" fill="${ACCENT}" fill-opacity="0.18"/>
    <text x="${x + 30}" y="${y + mid + 7}" fill="${ACCENT}" font-size="18" text-anchor="middle">★</text>
    <text x="${x + 55}" y="${y + mid + 8}" fill="${C.ink}" font-size="21" font-weight="700">${esc(b.name)}</text></g>`;
    x += w + 12;
  }
  return out;
}

function costLine(s) {
  if (!s.costCoverage.priced) return { value: '—', note: 'not recorded' };
  const note = s.costCoverage.priced < s.costCoverage.of
    ? `partial · ${s.costCoverage.priced} of ${s.costCoverage.of} priced` : '';
  return { value: fmtUsd(s.cost), note };
}

// Snaps are made to be shared; project names can be swapped for neutral ones.
const projectName = (i, p, hideAll) => (hideAll || p.hidden ? `Project ${'ABCDEFGH'[i]}` : p.name);

// compact trims the block by ~25px — a six-row month otherwise pushes the badges
// into the footer rule.
function feature(y, s, { heading, title, compact = false }) {
  const t = compact ? { title: 46, size: 40, sub: 82, chips: 100, chipH: 46 } : { title: 55, size: 46, sub: 95, chips: 120, chipH: 52 };
  if (!s.feature) {
    return `${label(P, y, heading)}
  <text x="${P}" y="${y + 56}" fill="${C.muted}" font-size="34" font-weight="700">No recorded sessions</text>`;
  }
  const a = s.feature.activity;
  const name = a.title;
  return `${label(P, y, heading)}
  <text x="${P}" y="${y + t.title}" fill="${C.ink}" font-size="${t.size}" font-weight="700" letter-spacing="-1">${esc(fit(name, t.size, W - 2 * P, true))}</text>
  <text x="${P}" y="${y + t.sub}" fill="${C.muted}" font-size="24">${esc(title)}</text>
  ${chips(P, y + t.chips, s.feature.badges, t.chipH)}`;
}

/* ---------------- weekly ---------------- */

export function renderWeekly(s, { athlete, title, hideProjects = false } = {}) {
  athlete = athlete || config().athlete || 'Athlete';
  const { start, end } = s.period;
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1);
  const sub = start.getMonth() === last.getMonth()
    ? `${start.getDate()}–${last.getDate()} ${MONTHS[last.getMonth()]} ${last.getFullYear()}`
    : `${start.getDate()} ${MONTHS[start.getMonth()].slice(0, 3)} – ${last.getDate()} ${MONTHS[last.getMonth()].slice(0, 3)} ${last.getFullYear()}`;

  // Chart: seven bars on a whole-hour scale.
  const panel = { x: P, y: 250, w: W - 2 * P, h: 380 };
  const plot = { x: panel.x + 96, y: panel.y + 88, w: panel.w - 128, h: 230 };
  const maxSec = Math.max(...s.days.map((d) => d.seconds), 0);
  const NICE = [1, 2, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192];
  const topH = NICE.find((n) => n * 3600 >= maxSec) || Math.ceil(maxSec / 3600);
  const slot = plot.w / 7, barW = slot * 0.56;
  let chart = '';
  for (const frac of [0, 0.5, 1]) {
    const y = plot.y + plot.h - plot.h * frac;
    chart += `<line x1="${plot.x}" y1="${y}" x2="${plot.x + plot.w}" y2="${y}" stroke="#ffffff" stroke-opacity="${frac ? 0.08 : 0.18}" ${frac ? 'stroke-dasharray="6 6"' : ''}/>
    <text x="${plot.x - 16}" y="${y + 7}" fill="${C.label}" font-size="20" text-anchor="end">${Math.round(topH * frac)}h</text>`;
  }
  const peak = s.days.reduce((m, d) => (d.seconds > m.seconds ? d : m), s.days[0]);
  s.days.forEach((d, i) => {
    const cx = plot.x + slot * i + slot / 2;
    if (d.seconds > 0) {
      const h = Math.max(6, plot.h * (d.seconds / (topH * 3600)));
      chart += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${(plot.y + plot.h - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="10" fill="${d === peak ? ACCENT : 'url(#bar)'}"/>`;
    }
    chart += `<text x="${cx.toFixed(1)}" y="${plot.y + plot.h + 40}" fill="${C.label}" font-size="19" font-weight="600" letter-spacing="1" text-anchor="middle">${DOW[i]}</text>`;
  });
  if (!s.sessions) {
    chart += `<text x="${panel.x + panel.w / 2}" y="${plot.y + plot.h / 2}" fill="${C.muted}" font-size="26" text-anchor="middle">No recorded sessions this week</text>`;
  }

  const cost = costLine(s);
  const inner = `
  <text x="${P}" y="215" fill="${C.ink}" font-size="58" font-weight="700" letter-spacing="-1.5">${esc(fit(title || 'Your week in code', 58, W - 2 * P, true))}</text>
  <rect x="${panel.x}" y="${panel.y}" width="${panel.w}" height="${panel.h}" rx="24" fill="${C.panel}"/>
  ${label(panel.x + 32, panel.y + 50, 'AGENT TIME')}
  <text x="${panel.x + panel.w - 32}" y="${panel.y + 50}" fill="${C.muted}" font-size="16" text-anchor="end">summed across sessions · parallel agents overlap</text>
  ${chart}
  ${headline(730, [[String(s.sessions), 'Sessions'], [String(s.activeDays), 'Active days'], [String(s.projectCount), hideProjects ? 'Projects' : 'Projects']])}
  <line x1="${P}" y1="808" x2="${W - P}" y2="808" stroke="#ffffff" stroke-opacity="0.08"/>
  ${headline(875, [[fmtHM(s.moving), 'Agent time'], [s.toolCalls.toLocaleString('en-US'), 'Tool calls'], [cost.value, 'Est. API cost']], 42)}
  ${cost.note ? `<text x="${P + 2 * (W - 2 * P) / 3}" y="935" fill="${C.muted}" font-size="16">${esc(cost.note)}</text>` : ''}
  <line x1="${P}" y1="960" x2="${W - P}" y2="960" stroke="#ffffff" stroke-opacity="0.08"/>
  ${feature(1008, s, { heading: 'SESSION SPOTLIGHT', title: s.feature ? `Longest session · ${fmtHM(s.feature.seconds)}` : '' })}`;

  return frame(inner, { athlete, sub, kind: 'WEEKLY SNAP', partial: s.partial ? 'THIS WEEK SO FAR' : '' });
}

/* ---------------- monthly ---------------- */

export function renderMonthly(s, { athlete, title, hideProjects = false } = {}) {
  athlete = athlete || config().athlete || 'Athlete';
  const { start } = s.period;
  const monthName = `${MONTHS[start.getMonth()]} ${start.getFullYear()}`;

  const panel = { x: P, y: 245, w: W - 2 * P };
  const inset = 32, gap = 10;
  const cellW = (panel.w - 2 * inset - 6 * gap) / 7, cellH = 46, pitch = cellH + gap;
  const lead = (start.getDay() + 6) % 7;                      // Monday-first offset
  const rows = Math.ceil((lead + s.days.length) / 7);          // 4, 5 or 6
  const gridTop = panel.y + 108;
  const gridBottom = gridTop + rows * pitch - gap;
  const legendY = gridBottom + 42;
  panel.h = legendY + 26 - panel.y;

  const maxSec = Math.max(...s.days.map((d) => d.seconds), 0);
  const level = (sec) => (sec <= 0 || !maxSec ? 0 : 1 + Math.floor(Math.min(0.999, sec / maxSec) * 4));
  const fillFor = (lvl) => (lvl ? ACCENT : C.panel2);
  const opacityFor = (lvl) => [1, 0.3, 0.5, 0.72, 1][lvl];

  let grid = '';
  DOW.forEach((d, i) => {
    grid += `<text x="${(panel.x + inset + i * (cellW + gap) + cellW / 2).toFixed(1)}" y="${panel.y + 88}" fill="${C.label}" font-size="18" font-weight="600" text-anchor="middle">${d[0]}</text>`;
  });
  for (let slotIdx = 0; slotIdx < rows * 7; slotIdx++) {
    const col = slotIdx % 7, row = Math.floor(slotIdx / 7);
    const x = panel.x + inset + col * (cellW + gap), y = gridTop + row * pitch;
    const day = s.days[slotIdx - lead];
    if (!day) {
      grid += `<rect x="${x.toFixed(1)}" y="${y}" width="${cellW.toFixed(1)}" height="${cellH}" rx="10" fill="#ffffff" fill-opacity="0.025"/>`;
      continue;
    }
    const lvl = level(day.seconds);
    grid += `<rect x="${x.toFixed(1)}" y="${y}" width="${cellW.toFixed(1)}" height="${cellH}" rx="10" fill="${fillFor(lvl)}" fill-opacity="${opacityFor(lvl)}"/>
    <text x="${(x + cellW / 2).toFixed(1)}" y="${y + 31}" fill="${lvl ? C.ink : C.label}" font-size="21" font-weight="${lvl ? 700 : 500}" text-anchor="middle">${day.date.getDate()}</text>`;
  }
  let legend = `<text x="${panel.x + inset}" y="${legendY + 7}" fill="${C.label}" font-size="19">Agent time</text>`;
  const sw = 26, legendRight = panel.x + panel.w - inset;
  legend += `<text x="${legendRight}" y="${legendY + 7}" fill="${C.label}" font-size="18" text-anchor="end">More</text>`;
  for (let i = 4; i >= 0; i--) {
    const x = legendRight - 58 - (4 - i) * (sw + 8) - sw;
    legend += `<rect x="${x}" y="${legendY - 13}" width="${sw}" height="${sw}" rx="6" fill="${fillFor(i)}" fill-opacity="${opacityFor(i)}"/>`;
  }
  legend += `<text x="${legendRight - 58 - 5 * (sw + 8) - 12}" y="${legendY + 7}" fill="${C.label}" font-size="18" text-anchor="end">Less</text>`;

  // Everything below the calendar is laid out from its actual height, so a
  // four-row February and a six-row month both land above the footer.
  const statsY = panel.y + panel.h + 78;
  const projY = statsY + 80;
  const top = s.projects.slice(0, 3);
  const maxProj = Math.max(...top.map((p) => p.seconds), 1);
  let projects = label(P, projY, 'PROJECTS BY AGENT TIME');
  top.forEach((p, i) => {
    const y = projY + 40 + i * 36;
    // Leave room for the widest duration label ("186h 41m") after the bar.
    const barX = P + 250, barMax = W - 2 * P - 250 - 140;
    projects += `<text x="${P}" y="${y}" fill="${C.ink}" font-size="22">${esc(fit(projectName(i, p, hideProjects), 22, 235))}</text>
    <rect x="${barX}" y="${y - 16}" width="${barMax}" height="18" rx="9" fill="${C.panel2}"/>
    <rect x="${barX}" y="${y - 16}" width="${Math.max(18, barMax * (p.seconds / maxProj)).toFixed(1)}" height="18" rx="9" fill="${ACCENT}"/>
    <text x="${W - P}" y="${y}" fill="${C.ink}" font-size="22" text-anchor="end">${fmtHM(p.seconds)}</text>`;
  });
  if (!top.length) projects += `<text x="${P}" y="${projY + 40}" fill="${C.muted}" font-size="22">No project recorded</text>`;

  const pickY = projY + 40 + Math.max(1, top.length) * 36 + 20;
  const f = s.feature;
  const pickTitle = !f ? '' : f.selected
    ? `Selected by you · ${fmtHM(f.seconds)}`
    : `${fmtHM(f.seconds)} · ${f.activity.date ? new Date(f.activity.date).getDate() + ' ' + MONTHS[new Date(f.activity.date).getMonth()].slice(0, 3) : ''}`;

  const cost = costLine(s);
  const inner = `
  <text x="${P}" y="210" fill="${C.ink}" font-size="58" font-weight="700" letter-spacing="-1.5">${esc(fit(title || 'Your month in code', 58, W - 2 * P, true))}</text>
  <rect x="${panel.x}" y="${panel.y}" width="${panel.w}" height="${panel.h}" rx="24" fill="${C.panel}"/>
  ${label(panel.x + inset, panel.y + 50, monthName.toUpperCase())}
  ${grid}${legend}
  ${headline(statsY, [[String(s.sessions), 'Sessions'], [String(s.activeDays), 'Active days'], [String(s.projectCount), 'Projects']], 60)}
  ${projects}
  ${feature(pickY, s, { heading: f && f.selected ? "MONTH'S PICK" : 'LONGEST SESSION', title: pickTitle, compact: true })}`;

  return frame(inner, { athlete, sub: monthName, kind: 'MONTHLY SNAP', partial: s.partial ? 'THIS MONTH SO FAR' : '' });
}
