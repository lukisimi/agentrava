#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { append, all } from './store.js';
import { clean, derive, fmtDuration, fmtPace, fmtNum, ACTIVITY_TYPES } from './metrics.js';
import { badgesFor, prsFor, streak } from './achievements.js';
import { renderCard } from './card.js';
import { photoDataUri } from './photo.js';
import { renderRecap } from './recap.js';
import { writeCard } from './render.js';

const num = (d) => ({ type: 'number', minimum: 0, description: d });

const LOG_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: Object.keys(ACTIVITY_TYPES),
      description: 'What kind of session this was. Defaults to "feature".' },
    title: { type: 'string', description: 'Optional. Left blank, it is auto-named Strava-style from the clock and type — "Morning Refactor", "Late Night Debug".' },
    summary: { type: 'string', description: 'One line on what you actually did. Shown under the title.' },
    athlete: { type: 'string', description: 'Who did the work. Defaults to "Claude".' },
    repo: { type: 'string', description: 'Repo or project name.' },
    duration_seconds: num('Wall-clock length of the session.'),
    tool_calls: num('How many tool calls you made.'),
    files_changed: num('Distinct files created or edited.'),
    lines_added: num('Lines added.'),
    lines_removed: num('Lines removed.'),
    tokens: num('Tokens burned, if you know it.'),
    tests_passed: num('Tests that passed.'),
    tests_failed: num('Tests that failed.'),
    errors_recovered: num('Times you hit an error and worked past it. These draw as loops on the route map — be honest, they are the best part.'),
    languages: { type: 'array', items: { type: 'string' }, description: 'Languages touched.' },
    date: { type: 'string', description: 'ISO timestamp. Defaults to now.' },
    photo: { type: 'string', description: 'Path to a local image (jpg/png/gif/webp, under 8 MB) to use as the card background, with the route drawn over it — Strava-style. Ask the user for one; do not invent a path.' },
  },
  additionalProperties: false,
};

const TOOLS = [
  {
    name: 'log_activity',
    title: 'Log an activity',
    description:
      'Finish a coding session and get a Strava-style achievement card back as an image. ' +
      'Report the session honestly — line churn becomes distance, files and recovered errors become elevation, ' +
      'and the card awards badges and personal records against your own history. ' +
      'Call this when the user asks you to brag, or at the end of a session worth remembering.',
    inputSchema: LOG_SCHEMA,
  },
  {
    name: 'get_profile',
    title: 'Athlete profile',
    description: 'Career totals, current streak, personal records and the trophy case across every logged activity.',
    inputSchema: { type: 'object', properties: {
      athlete: { type: 'string', description: 'Filter to one athlete.' } }, additionalProperties: false },
  },
  {
    name: 'list_activities',
    title: 'Recent activities',
    description: 'The feed: recent logged sessions with their headline stats.',
    inputSchema: { type: 'object', properties: {
      limit: { type: 'number', description: 'How many, newest first. Default 10.' },
      athlete: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'recap',
    title: 'Season recap',
    description:
      'One card summarising a whole period: totals, a day-by-day activity heatmap, ' +
      'an hour-of-day histogram of when the work actually happened, the trophy case, ' +
      'longest streak and biggest session. Defaults to everything logged.',
    inputSchema: { type: 'object', properties: {
      from: { type: 'string', description: 'Start date, YYYY-MM-DD. Omit for the beginning.' },
      to: { type: 'string', description: 'End date, YYYY-MM-DD. Omit for today.' },
      title: { type: 'string', description: 'Headline. Defaults to "N Activities".' },
      athlete: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'leaderboard',
    title: 'Leaderboard',
    description: 'Rank logged sessions by a metric: distance, elevation, duration, effort, tokens or tool_calls.',
    inputSchema: { type: 'object', properties: {
      metric: { type: 'string', enum: ['distance', 'elevation', 'duration', 'effort', 'tokens', 'tool_calls'] },
      limit: { type: 'number' } }, additionalProperties: false },
  },
];

/* ---------------- handlers ---------------- */

function logActivity(args) {
  let photoError = null;
  const a = clean(args);
  const history = all();
  const badges = badgesFor(a);
  const prs = prsFor(a, history);
  const st = streak([...history, a]);

  let photo = null;
  try { photo = a.photo ? photoDataUri(a.photo) : null; } catch (err) { photoError = err.message; }
  const svg = renderCard(a, { badges, prs, streak: st, photo });
  const { pngPath, svgPath, png } = writeCard(a.id, svg);
  append({ ...a, badges: badges.map((b) => b.id), prs: prs.map((p) => p.id), card: pngPath || svgPath });

  const d = derive(a);
  const lines = [
    `🏅  ${a.title}${a.repo ? ` · ${a.repo}` : ''}`,
    `${d.distance_km.toFixed(2)} km  ·  ${Math.round(d.elevation_m)} m climbed  ·  ${fmtDuration(a.duration_seconds)}  ·  ${fmtPace(d.pace_min_per_km)} /km  ·  effort ${d.effort}`,
    prs.length ? `🥇 Personal record: ${prs.map((p) => p.name).join(', ')}` : '',
    badges.length ? `Achievements: ${badges.map((b) => b.name).join(', ')}` : 'No badges this time. Go harder.',
    st > 1 ? `🔥 ${st}-day streak` : '',
    photoError ? `Photo skipped: ${photoError}` : '',
    `Card saved to ${pngPath || svgPath}`,
  ].filter(Boolean);

  const content = [{ type: 'text', text: lines.join('\n') }];
  if (png) content.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
  return { content };
}

function recap({ from, to, title, athlete } = {}) {
  let acts = all();
  if (from) acts = acts.filter((a) => a.date.slice(0, 10) >= from);
  if (to) acts = acts.filter((a) => a.date.slice(0, 10) <= to);
  if (athlete) acts = acts.filter((a) => a.athlete.toLowerCase() === athlete.toLowerCase());
  if (!acts.length) return text('No activities in that range.');

  const svg = renderRecap(acts, { athlete: athlete || 'Claude', title });
  const key = `recap-${from || 'all'}${to ? '-' + to : ''}`;
  const { pngPath, svgPath, png } = writeCard(key, svg);

  const t = acts.reduce((acc, a) => {
    const d = derive(a);
    acc.km += d.distance_km; acc.m += d.elevation_m; acc.sec += a.duration_seconds;
    acc.tokens += a.tokens; acc.calls += a.tool_calls;
    return acc;
  }, { km: 0, m: 0, sec: 0, tokens: 0, calls: 0 });

  const content = [{ type: 'text', text:
    `${acts.length} activities  ·  ${t.km.toFixed(0)} km  ·  ${fmtNum(Math.round(t.m))} m climbed  ·  ` +
    `${fmtDuration(t.sec)} moving  ·  ${fmtNum(t.tokens)} tokens  ·  ${fmtNum(t.calls)} tool calls\n` +
    `Recap saved to ${pngPath || svgPath}` }];
  if (png) content.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
  return { content };
}

function getProfile({ athlete } = {}) {
  let acts = all();
  if (athlete) acts = acts.filter((a) => a.athlete.toLowerCase() === athlete.toLowerCase());
  if (!acts.length) return text('No activities logged yet. Call log_activity to open your account.');

  const t = acts.reduce((acc, a) => {
    const d = derive(a);
    acc.km += d.distance_km; acc.m += d.elevation_m; acc.sec += a.duration_seconds;
    acc.tokens += a.tokens; acc.calls += a.tool_calls; acc.files += a.files_changed;
    return acc;
  }, { km: 0, m: 0, sec: 0, tokens: 0, calls: 0, files: 0 });

  const trophies = {};
  for (const a of acts) for (const b of a.badges || []) trophies[b] = (trophies[b] || 0) + 1;

  const best = (label, fn, fmt) => {
    const top = acts.slice().sort((x, y) => fn(y) - fn(x))[0];
    return `  ${label.padEnd(16)} ${fmt(fn(top))}   — ${top.title}`;
  };

  return text([
    `AGENTRAVA — ${athlete || 'all athletes'}`,
    ``,
    `${acts.length} activities  ·  ${t.km.toFixed(1)} km  ·  ${fmtNum(t.m)} m climbed  ·  ${fmtDuration(t.sec)} moving`,
    `${fmtNum(t.tokens)} tokens  ·  ${t.calls} tool calls  ·  ${t.files} files touched`,
    `Current streak: ${streak(acts)} day(s)`,
    ``,
    `PERSONAL RECORDS`,
    best('Longest', (a) => a.duration_seconds, fmtDuration),
    best('Most churn', (a) => derive(a).distance_km, (v) => v.toFixed(2) + ' km'),
    best('Biggest climb', (a) => derive(a).elevation_m, (v) => Math.round(v) + ' m'),
    best('Highest cadence', (a) => derive(a).cadence, (v) => v.toFixed(1) + ' calls/min'),
    best('Hardest effort', (a) => derive(a).effort, (v) => String(v)),
    ``,
    `TROPHY CASE`,
    Object.keys(trophies).length
      ? Object.entries(trophies).sort((a, b) => b[1] - a[1])
          .map(([id, n]) => `  ${id.replace(/_/g, ' ')} ×${n}`).join('\n')
      : '  (empty)',
  ].join('\n'));
}

function listActivities({ limit = 10, athlete } = {}) {
  let acts = all();
  if (athlete) acts = acts.filter((a) => a.athlete.toLowerCase() === athlete.toLowerCase());
  acts = acts.slice(-Math.max(1, Math.min(50, limit))).reverse();
  if (!acts.length) return text('Nothing logged yet.');
  return text(acts.map((a) => {
    const d = derive(a);
    return `${new Date(a.date).toISOString().slice(0, 16).replace('T', ' ')}  ${a.title}\n` +
           `    ${d.distance_km.toFixed(2)} km · ${Math.round(d.elevation_m)} m · ${fmtDuration(a.duration_seconds)} · effort ${d.effort}` +
           `${(a.badges || []).length ? ` · ${a.badges.length} badge(s)` : ''}`;
  }).join('\n'));
}

function leaderboard({ metric = 'distance', limit = 10 } = {}) {
  const get = {
    distance: (a) => derive(a).distance_km, elevation: (a) => derive(a).elevation_m,
    duration: (a) => a.duration_seconds, effort: (a) => derive(a).effort,
    tokens: (a) => a.tokens, tool_calls: (a) => a.tool_calls,
  }[metric] || ((a) => derive(a).distance_km);
  const fmt = { distance: (v) => v.toFixed(2) + ' km', elevation: (v) => Math.round(v) + ' m',
    duration: fmtDuration, effort: String, tokens: fmtNum, tool_calls: String }[metric] || String;

  const acts = all().slice().sort((a, b) => get(b) - get(a)).slice(0, Math.max(1, Math.min(50, limit)));
  if (!acts.length) return text('Nothing logged yet.');
  return text(`LEADERBOARD — ${metric}\n` + acts.map((a, i) =>
    `${String(i + 1).padStart(2)}. ${fmt(get(a)).padStart(10)}   ${a.title} (${a.athlete})`).join('\n'));
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });

/* ---------------- wiring ---------------- */

const server = new Server(
  { name: 'agentrava', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    switch (name) {
      case 'log_activity':    return logActivity(args);
      case 'get_profile':     return getProfile(args);
      case 'recap':           return recap(args);
      case 'list_activities': return listActivities(args);
      case 'leaderboard':     return leaderboard(args);
      default: return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `agentrava failed: ${err.message}` }] };
  }
});

await server.connect(new StdioServerTransport());
