import { ACTIVITY_TYPES, derive, fmtDuration, fmtPace, fmtNum } from './metrics.js';

const W = 1080, H = 1350, P = 64;
export const C = {
  bg0: '#0d0f13', bg1: '#171b23', panel: '#1b212b', panel2: '#232a36',
  ink: '#ffffff', muted: '#8b93a3', dim: '#5b6373', brand: '#fc5200',
};

/* ---------- tiny deterministic PRNG so a card always redraws identically ---------- */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// SVG can't wrap text, so every string is measured and cut here.
export const charW = (size, bold) => size * (bold ? 0.56 : 0.51);
export function fit(s, size, maxW, bold = false) {
  const max = Math.floor(maxW / charW(size, bold));
  s = String(s);
  return s.length <= max ? s : s.slice(0, Math.max(1, max - 1)).trimEnd() + '…';
}
function wrap(s, size, maxW, maxLines) {
  const max = Math.floor(maxW / charW(size, false));
  const words = String(s).split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= max) cur += ' ' + w;
    else { lines.push(cur); cur = w; if (lines.length === maxLines) break; }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length)
    lines[maxLines - 1] = fit(lines[maxLines - 1] + '…', size, maxW);
  return lines;
}

/* ---------- the route: a GPS trace synthesised from how the session actually went ---------- */
function buildRoute(a, d) {
  const r = rng(hash(a.id + a.title));
  const steps = Math.round(Math.min(240, Math.max(26, a.tool_calls * 2.2 + 24)));
  // Radius tracks total path length so a busy session spreads out instead of
  // scribbling over itself: area ~ length x comfortable line spacing.
  const radius = 9 * Math.sqrt(steps);
  const pts = [];
  let x = 0, y = 0, heading = r() * Math.PI * 2;
  // Where the agent got stuck, the route loops back on itself.
  const loops = new Set();
  const loopCount = Math.min(4, a.errors_recovered);
  for (let i = 1; i <= loopCount; i++) loops.add(Math.floor((steps * i) / (loopCount + 1)));

  for (let i = 0; i < steps; i++) {
    if (loops.has(i)) {
      // Proportional to the route's own scale — a fixed radius swallows a short trace.
      const rad = Math.max(16, radius * (0.15 + r() * 0.09)), dir = r() < 0.5 ? 1 : -1;
      const cx = x + Math.cos(heading + Math.PI / 2) * rad * dir;
      const cy = y + Math.sin(heading + Math.PI / 2) * rad * dir;
      let ang = Math.atan2(y - cy, x - cx);
      for (let k = 0; k < 16; k++) {
        ang += (Math.PI * 2 / 16) * dir;
        pts.push([cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad]);
      }
      x = pts[pts.length - 1][0]; y = pts[pts.length - 1][1];
      continue;
    }
    heading += (r() - 0.5) * 0.5 + Math.sin(i / 11) * 0.07;
    // Free drift wanders off in one direction and fits as a thin column; a sweep
    // added to the heading spirals. A soft pull home once outside the target
    // radius keeps the trace blob-shaped and untangled.
    const dist = Math.hypot(x, y);
    if (dist > radius) {
      const home = Math.atan2(-y, -x);
      const diff = ((home - heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      heading += diff * Math.min(0.3, ((dist - radius) / radius) * 0.35);
    }
    const step = 7 + r() * 6;
    x += Math.cos(heading) * step; y += Math.sin(heading) * step;
    pts.push([x, y]);
  }
  return pts;
}

function fitPoints(pts, box) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const s = Math.min(box.w / Math.max(maxX - minX, 1), box.h / Math.max(maxY - minY, 1));
  const ox = box.x + (box.w - (maxX - minX) * s) / 2;
  const oy = box.y + (box.h - (maxY - minY) * s) / 2;
  return pts.map(([px, py]) => [ox + (px - minX) * s, oy + (py - minY) * s]);
}

const pathOf = (pts) => pts.map(([x, y], i) =>
  `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');

function elevationPath(a, box) {
  const r = rng(hash(a.id + 'elev'));
  const n = 72, vals = [];
  let v = 0.4;
  for (let i = 0; i < n; i++) {
    // Mean-reverting, or the walk pins itself to the ceiling and draws a brick.
    v += (r() - 0.5) * 0.26 + (0.45 - v) * 0.13 + Math.sin(i / 6.5) * 0.05;
    vals.push(Math.min(0.95, Math.max(0.08, v)));
  }
  const step = box.w / (n - 1);
  const line = vals.map((val, i) =>
    `${i ? 'L' : 'M'}${(box.x + i * step).toFixed(1)} ${(box.y + box.h - val * box.h).toFixed(1)}`).join(' ');
  return { line, area: `${line} L${(box.x + box.w).toFixed(1)} ${box.y + box.h} L${box.x} ${box.y + box.h} Z` };
}

/* ---------- pieces ---------- */
function bigStat(x, y, value, unit, label) {
  const vw = value.length * charW(66, true);
  return `
  <text x="${x}" y="${y}" fill="${C.ink}" font-size="66" font-weight="700" letter-spacing="-1">${esc(value)}</text>
  ${unit ? `<text x="${(x + vw + 8).toFixed(0)}" y="${y}" fill="${C.muted}" font-size="26" font-weight="600">${esc(unit)}</text>` : ''}
  <text x="${x}" y="${y + 34}" fill="${C.dim}" font-size="19" font-weight="600" letter-spacing="1.6">${esc(label.toUpperCase())}</text>`;
}
function smallStat(x, y, value, label, color) {
  return `
  <text x="${x}" y="${y}" fill="${color || C.ink}" font-size="38" font-weight="700" letter-spacing="-0.5">${esc(value)}</text>
  <text x="${x}" y="${y + 28}" fill="${C.dim}" font-size="17" font-weight="600" letter-spacing="1.4">${esc(label.toUpperCase())}</text>`;
}
const CHIP_SIZE = 21;
const chipLabel = (t) => fit(t, CHIP_SIZE, 300, true);
const chipWidth = (t) => Math.ceil(chipLabel(t).length * charW(CHIP_SIZE, true)) + 78;

function chip(x, y, text, accent, isPR, ghost) {
  const size = CHIP_SIZE;
  const label = chipLabel(text);
  const w = chipWidth(text);
  if (ghost) return { w, svg: `
  <g>
    <rect x="${x}" y="${y}" rx="27" ry="27" width="${w}" height="54" fill="none" stroke="${C.panel2}" stroke-width="2"/>
    <text x="${x + w / 2}" y="${y + 35}" fill="${C.dim}" font-size="${size}" font-weight="700" text-anchor="middle">${esc(label)}</text>
  </g>` };
  return { w, svg: `
  <g>
    <rect x="${x}" y="${y}" rx="27" ry="27" width="${w}" height="54" fill="${isPR ? C.brand : C.panel2}" fill-opacity="${isPR ? 1 : 1}"/>
    <circle cx="${x + 31}" cy="${y + 27}" r="15" fill="${isPR ? '#ffffff' : accent}" fill-opacity="${isPR ? 0.22 : 0.18}"/>
    <path d="M${x + 31} ${y + 19} l3.4 6.9 7.6 1.1 -5.5 5.4 1.3 7.6 -6.8 -3.6 -6.8 3.6 1.3 -7.6 -5.5 -5.4 7.6 -1.1 Z"
          fill="${isPR ? '#ffffff' : accent}" transform="scale(0.78) translate(${(x + 31) * 0.282}, ${(y + 27) * 0.282})"/>
    <text x="${x + 56}" y="${y + 35}" fill="${isPR ? '#ffffff' : C.ink}" font-size="${size}" font-weight="700">${esc(label)}</text>
  </g>` };
}

/* ---------- the card ---------- */
export function renderCard(a, { badges = [], prs = [], streak = 0, photo = null } = {}) {
  const d = derive(a);
  const meta = ACTIVITY_TYPES[a.type] || ACTIVITY_TYPES.feature;
  const accent = meta.color;

  const mapBox = { x: P, y: 330, w: W - 2 * P, h: 430 };
  const routeBox = { x: mapBox.x + 30, y: mapBox.y + 24, w: mapBox.w - 60, h: 278 };
  const elevBox = { x: mapBox.x + 30, y: mapBox.y + 348, w: mapBox.w - 60, h: 56 };
  const route = fitPoints(buildRoute(a, d), routeBox);
  const elev = elevationPath(a, elevBox);
  const start = route[0], end = route[route.length - 1];

  const dateStr = new Date(a.date).toLocaleDateString('en-GB',
    { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const subtitle = [dateStr, a.repo].filter(Boolean).join('  ·  ');
  const summaryLines = a.summary ? wrap(a.summary, 24, W - 2 * P, 2) : [];

  // Chips: personal records first — they are the rarest thing on the card.
  const items = [...prs.map((p) => ({ t: p.name + ' PR', pr: true })),
                 ...badges.map((b) => ({ t: b.name, pr: false }))];
  const MAXW = W - 2 * P;
  const rows = [[], []]; const rowW = [0, 0];
  let overflow = 0;
  for (const it of items) {
    const cw = chipWidth(it.t) + 12;
    if (rowW[0] + cw <= MAXW) { rows[0].push(it); rowW[0] += cw; }
    else if (rowW[1] + cw <= MAXW) { rows[1].push(it); rowW[1] += cw; }
    else overflow++;
  }
  if (overflow) {
    // Never drop badges silently — trade the last one for an honest count.
    let more = overflow, cw = chipWidth(`+${more} more`) + 12;
    while (rows[1].length && rowW[1] + cw > MAXW) {
      const dropped = rows[1].pop();
      rowW[1] -= chipWidth(dropped.t) + 12;
      more++; cw = chipWidth(`+${more} more`) + 12;
    }
    rows[1].push({ t: `+${more} more`, pr: false, ghost: true });
  }
  let chipsSvg = '';
  rows.forEach((row, ri) => {
    let x = P;
    for (const it of row) {
      const c = chip(x, 1110 + ri * 66, it.t, accent, it.pr, it.ghost);
      chipsSvg += c.svg; x += c.w + 12;
    }
  });
  const hasChips = rows[0].length > 0;

  const gridLines = Array.from({ length: 9 }, (_, i) =>
    `<line x1="${mapBox.x}" y1="${mapBox.y + 40 * (i + 1)}" x2="${mapBox.x + mapBox.w}" y2="${mapBox.y + 40 * (i + 1)}" stroke="#ffffff" stroke-opacity="0.028"/>`)
    .concat(Array.from({ length: 17 }, (_, i) =>
      `<line x1="${mapBox.x + 56 * (i + 1)}" y1="${mapBox.y}" x2="${mapBox.x + 56 * (i + 1)}" y2="${mapBox.y + mapBox.h}" stroke="#ffffff" stroke-opacity="0.028"/>`))
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="${C.bg1}"/><stop offset="1" stop-color="${C.bg0}"/>
    </linearGradient>
    <linearGradient id="photoscrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.72"/>
    </linearGradient>
    <linearGradient id="elevfill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${accent}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="${accent}" stop-opacity="0.02"/>
    </linearGradient>
    <clipPath id="mapclip"><rect x="${mapBox.x}" y="${mapBox.y}" width="${mapBox.w}" height="${mapBox.h}" rx="26"/></clipPath>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect x="0" y="0" width="${W}" height="8" fill="${accent}"/>

  <!-- header -->
  <circle cx="${P + 33}" cy="103" r="33" fill="${accent}" fill-opacity="0.18"/>
  <circle cx="${P + 33}" cy="103" r="33" fill="none" stroke="${accent}" stroke-opacity="0.5" stroke-width="2"/>
  <text x="${P + 33}" y="114" fill="${accent}" font-size="32" font-weight="700" text-anchor="middle">${esc(a.athlete.slice(0, 1).toUpperCase())}</text>
  <text x="${P + 84}" y="95" fill="${C.ink}" font-size="29" font-weight="700">${esc(fit(a.athlete, 29, 500, true))}</text>
  <text x="${P + 84}" y="127" fill="${C.muted}" font-size="21">${esc(fit(subtitle, 21, 700))}</text>
  <text x="${W - P}" y="98" fill="${C.dim}" font-size="19" font-weight="700" letter-spacing="2" text-anchor="end">${esc(a.type.toUpperCase())}</text>
  ${streak > 1 ? `<text x="${W - P}" y="127" fill="${accent}" font-size="21" font-weight="700" text-anchor="end">${streak}-day streak</text>` : ''}

  <!-- title -->
  <text x="${P}" y="228" fill="${C.ink}" font-size="56" font-weight="700" letter-spacing="-1.2">${esc(fit(a.title, 56, W - 2 * P, true))}</text>
  ${summaryLines.map((l, i) => `<text x="${P}" y="${272 + i * 32}" fill="${C.muted}" font-size="24">${esc(l)}</text>`).join('')}

  <!-- map -->
  <rect x="${mapBox.x}" y="${mapBox.y}" width="${mapBox.w}" height="${mapBox.h}" rx="26" fill="${C.panel}"/>
  <g clip-path="url(#mapclip)">
    ${photo ? `<image href="${photo}" x="${mapBox.x}" y="${mapBox.y}" width="${mapBox.w}" height="${mapBox.h}" preserveAspectRatio="xMidYMid slice"/>
    <rect x="${mapBox.x}" y="${mapBox.y}" width="${mapBox.w}" height="${mapBox.h}" fill="#000000" fill-opacity="0.46"/>` : gridLines}
    <path d="${pathOf(route)}" fill="none" stroke="#000000" stroke-opacity="${photo ? 0.55 : 0.35}" stroke-width="${photo ? 12 : 9}" stroke-linecap="round" stroke-linejoin="round" transform="translate(0,3)"/>
    <path d="${pathOf(route)}" fill="none" stroke="${accent}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${start[0].toFixed(1)}" cy="${start[1].toFixed(1)}" r="11" fill="#26c281" stroke="${C.panel}" stroke-width="4"/>
    <circle cx="${end[0].toFixed(1)}" cy="${end[1].toFixed(1)}" r="11" fill="${C.ink}" stroke="${C.panel}" stroke-width="4"/>
    ${photo ? `<rect x="${mapBox.x}" y="${elevBox.y - 90}" width="${mapBox.w}" height="${mapBox.h - (elevBox.y - 90 - mapBox.y)}" fill="url(#photoscrim)"/>` : ''}
    <line x1="${mapBox.x + 30}" y1="${elevBox.y - 22}" x2="${mapBox.x + mapBox.w - 30}" y2="${elevBox.y - 22}" stroke="#ffffff" stroke-opacity="${photo ? 0.16 : 0.07}"/>
    <path d="${elev.area}" fill="url(#elevfill)"/>
    <path d="${elev.line}" fill="none" stroke="${accent}" stroke-opacity="0.85" stroke-width="2.5"/>
    <text x="${mapBox.x + 30}" y="${elevBox.y - 34}" fill="${photo ? '#ffffff' : C.dim}" fill-opacity="${photo ? 0.72 : 1}" font-size="16" font-weight="600" letter-spacing="1.4">ELEVATION PROFILE</text>
  </g>

  <!-- headline stats -->
  ${bigStat(P, 856, d.distance_km.toFixed(2), 'km', 'Distance')}
  ${bigStat(P + 322, 856, Math.round(d.elevation_m).toLocaleString('en-US'), 'm', 'Elevation')}
  ${bigStat(P + 644, 856, fmtDuration(a.duration_seconds), '', 'Moving Time')}

  <line x1="${P}" y1="926" x2="${W - P}" y2="926" stroke="#ffffff" stroke-opacity="0.08"/>

  ${smallStat(P, 990, fmtPace(d.pace_min_per_km) + ' /km', 'Pace')}
  ${smallStat(P + 246, 990, String(a.tool_calls), 'Tool calls')}
  ${smallStat(P + 492, 990, fmtNum(a.tokens), 'Tokens burned')}
  ${smallStat(P + 720, 990, String(d.effort), 'Effort', d.effort >= 80 ? '#e0245e' : C.ink)}

  ${hasChips ? `<text x="${P}" y="1082" fill="${C.dim}" font-size="17" font-weight="700" letter-spacing="2">ACHIEVEMENTS</text>` : ''}
  ${chipsSvg}

  <!-- footer -->
  <line x1="${P}" y1="1252" x2="${W - P}" y2="1252" stroke="#ffffff" stroke-opacity="0.08"/>
  <text x="${P}" y="1302" fill="${C.brand}" font-size="30" font-weight="700" letter-spacing="4">AGENTRAVA</text>
  <text x="${W - P}" y="1302" fill="${C.dim}" font-size="20" text-anchor="end">${esc(
    [a.lines_added ? `+${fmtNum(a.lines_added)}` : '', a.lines_removed ? `−${fmtNum(a.lines_removed)}` : '',
     `${a.files_changed} files`,
     a.edits_accepted ? `${a.edits_accepted} edits kept${a.edits_rejected ? ` / ${a.edits_rejected} sent back` : ''}` : '',
     a.languages.join(' / ')].filter(Boolean).join('  ·  '))}</text>
</svg>`;
}
