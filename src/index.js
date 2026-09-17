#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import fs from 'node:fs';
import { append, all, load, save, config, setConfig, presentAll, setOverride } from './store.js';
import { renameSession, renameProject, listProjects, describeProject } from './names.js';
import { setAvatar } from './avatar.js';
import { redrawCards } from './redraw.js';
import { clean, derive, fmtDuration, fmtPace, fmtNum, ACTIVITY_TYPES } from './metrics.js';
import { badgesFor, prsFor, streak } from './achievements.js';
import { renderCard } from './card.js';
import { photoDataUri, resolvePhotoPath } from './photo.js';
import { fmtUsd } from './pricing.js';
import { logSession } from './session.js';
import { resolveTranscript } from './transcripts.js';
import { renderRecap } from './recap.js';
import { resolvePeriod, dayKey } from './periods.js';
import { summarize, fmtHM } from './summary.js';
import { renderWeekly, renderMonthly } from './snap.js';
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
    photo: { type: 'string', description: 'Card background, with the route drawn over it — Strava-style. A local image path (jpg/png/gif/webp, under 8 MB), or "chat" to use the image the user most recently pasted into this conversation. Ask the user for one; do not invent a path.' },
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
    name: 'agentrava',
    title: 'What Agentrava can do',
    description:
      'Start here. Lists every Agentrava tool with a one-line example, plus the current athlete, ' +
      'totals and streak. Call this whenever the user says just "agentrava", asks what it can do, ' +
      'or seems unsure which card they want.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'snapshot',
    title: 'Snapshot the current session',
    description:
      'Log the session that is running right now and return its card — mid-session, ' +
      'without waiting for it to end. Numbers are measured from the transcript ' +
      '(tool calls, tokens, diffs, recovered errors, moving time), not reported by you, ' +
      'so prefer this over log_activity whenever the work happened in Claude Code. ' +
      'Safe to call repeatedly: it updates the same activity instead of adding duplicates. ' +
      'With no argument it guesses the current session (matching working directory, else most ' +
      'recently written) and names which it chose — check that before repeating the numbers.',
    inputSchema: { type: 'object', properties: {
      session: { type: 'string', description: 'Session id prefix. Omit for the session in progress.' },
      photo: { type: 'string', description: 'Card background: a local image path, or "chat" to use the image the user most recently pasted into this conversation.' },
    }, additionalProperties: false },
  },
  {
    name: 'set_athlete',
    title: 'Set the athlete name',
    description:
      'Set the name shown on every card. The athlete is the person whose account this is — ' +
      'the model that did the work is recorded separately as gear. Applies to past cards too. ' +
      'Ask the user what they want; do not guess a name from their email or filesystem.',
    inputSchema: { type: 'object', properties: {
      name: { type: 'string', description: 'Display name, first name or full name. Max 40 characters.' },
      avatar: { type: 'string', description: 'Profile picture for the circle on every card: a local image path, or "chat" to use an image the user just pasted. Square images look best.' },
      avatar_reset: { type: 'boolean', description: 'Remove the picture and go back to the initial.' },
    }, additionalProperties: false },
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
    name: 'rename_session',
    title: 'Rename a session',
    description:
      'Give a session a title of your own; its cards are redrawn. The generated title is kept, ' +
      'so reset restores it. Survives re-logging and backfills. Refuses an ambiguous id prefix.',
    inputSchema: { type: 'object', properties: {
      session: { type: 'string', description: 'Session or activity id, or an unambiguous prefix.' },
      title: { type: 'string', description: 'New title, up to 60 characters.' },
      reset: { type: 'boolean', description: 'Restore the generated title.' },
    }, required: ['session'], additionalProperties: false },
  },
  {
    name: 'rename_project',
    title: 'Rename or hide a project',
    description:
      'Set the display name for a project everywhere it appears — session cards, snaps, profile. ' +
      'Projects are identified by repository path, so two repos with the same name stay separate and ' +
      'two projects given the same name are not merged. hidden keeps the name off every card.',
    inputSchema: { type: 'object', properties: {
      project: { type: 'string', description: 'Current display name, repository name, or repository path.' },
      name: { type: 'string', description: 'New display name, up to 60 characters.' },
      reset: { type: 'boolean', description: 'Restore the repository name.' },
      hidden: { type: 'boolean', description: 'true keeps the project name off cards; false shows it again.' },
    }, required: ['project'], additionalProperties: false },
  },
  {
    name: 'list_projects',
    title: 'List projects',
    description: 'Every project with its display name, repository path, session count and time — use before renaming.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'weekly_snap',
    title: 'Weekly Snap',
    description:
      'A 1080×1350 card for one Monday-to-Sunday week: agent time per day, sessions, active days, ' +
      'projects, tool calls, estimated API cost and the longest session. An unfinished week is ' +
      'marked "this week so far". Agent time is summed across sessions, so parallel agents can ' +
      'exceed 24h a day — say so if you repeat the numbers.',
    inputSchema: { type: 'object', properties: {
      period: { type: 'string', description: 'this (default) for the calendar week so far, last for the previous one, last7 for a rolling seven days ending today (always complete — better for sharing mid-week), or a date YYYY-MM-DD inside the week.' },
      title: { type: 'string', description: 'Replace the headline, e.g. "What I shipped". Never inferred.' },
      hide_projects: { type: 'boolean', description: 'Swap project names for Project A/B/C before sharing.' },
    }, additionalProperties: false },
  },
  {
    name: 'monthly_snap',
    title: 'Monthly Snap',
    description:
      'A 1080×1350 card for one calendar month: a Monday-first heatmap of agent time, sessions, ' +
      'active days, projects by time, and a featured session. The feature is labelled "Month\'s pick" ' +
      'only when the user chose it via `pick`; otherwise it is the longest session, labelled as such.',
    inputSchema: { type: 'object', properties: {
      period: { type: 'string', description: 'this (default) for the calendar month so far, last for the previous one, last30 (or 14d, 90d…) for a rolling window ending today, or YYYY-MM / YYYY-MM-DD.' },
      title: { type: 'string', description: 'Replace the headline, e.g. "What I shipped". Never inferred.' },
      hide_projects: { type: 'boolean', description: 'Swap project names for Project A/B/C before sharing.' },
      pick: { type: 'string', description: 'Session or activity id the user chose to feature. Only pass one the user named.' },
    }, additionalProperties: false },
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
  try {
    const p = a.photo ? resolvePhotoPath(a.photo, (resolveTranscript(null) || {}).file) : null;
    if (p) { photo = photoDataUri(p); a.photo = p; }
  } catch (err) { photoError = err.message; }
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
  let acts = presentAll();
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

async function snapshot({ session, photo, title } = {}) {
  const t = resolveTranscript(session);
  if (!t) return text(session ? `No session matching "${session}".` : 'No Claude Code transcripts found.');

  const r = await logSession({ sessionId: t.id, transcriptPath: t.file });
  if (r.skipped) return text(`Nothing to log for ${t.id.slice(0, 8)} — ${r.skipped}.`);

  // Save the photo as an override before redrawing — drawing it once without
  // saving it meant the next re-log quietly took it off again.
  let card = r.card;
  if (photo) {
    try {
      const file = resolvePhotoPath(photo, t.file);
      photoDataUri(file);                                  // validate before storing
      setOverride(t.id, { photo: file });
      card = redrawCards((a) => a.id === r.stored.id)[0] || card;
    } catch (err) { return text(`Photo failed: ${err.message}`); }
  }
  if (title !== undefined) {
    try { renameSession(r.stored.id, title); card = redrawCards((a) => a.id === r.stored.id)[0] || card; }
    catch (err) { return text(err.message); }
  }
  const shown = presentAll([{ ...r.activity, id: r.stored.id }])[0];

  const d = derive(r.activity);
  const lines = [
    `🏅  ${shown.title}${shown.project_name && !shown.project_hidden ? ` · ${shown.project_name}` : ''}  (in progress)`,
    `session ${t.id.slice(0, 8)} — picked by ${t.why}${t.why !== 'requested' ? '; pass `session` if that is the wrong one' : ''}`,
    `${d.distance_km.toFixed(2)} km  ·  ${Math.round(d.elevation_m)} m climbed  ·  ${fmtDuration(r.activity.duration_seconds)}  ·  ` +
      `${fmtPace(d.pace_min_per_km)} /km  ·  effort ${d.effort}`,
    `${r.activity.tool_calls} tool calls  ·  ${fmtNum(r.activity.tokens)} tokens  ·  ` +
      `${r.activity.files_changed} files  ·  ${r.activity.errors_recovered} errors climbed`,
    r.prs.length ? `🥇 Personal record: ${r.prs.map((p) => p.name).join(', ')}` : '',
    r.badges.length ? `Achievements: ${r.badges.map((b) => b.name).join(', ')}` : 'No badges yet.',
    `Card: ${card}`,
    nextSteps([
      shown.photo ? 'swap the background image (photo: "chat" uses one they paste here)' : 'put an image behind the route (photo: "chat" uses one they paste here)',
      'rename this session (title, or rename_session with reset to undo)',
      shown.project_name && !shown.project_hidden ? `rename or hide the project "${shown.project_name}" (rename_project)` : '',
    ]),
  ].filter(Boolean);

  const content = [{ type: 'text', text: lines.join('\n') }];
  if (card && card.endsWith('.png')) {
    content.push({ type: 'image', data: fs.readFileSync(card).toString('base64'), mimeType: 'image/png' });
  }
  return { content };
}

function setAthlete({ name, avatar, avatar_reset: avatarReset } = {}) {
  // Avatar first: it can be set on its own, without renaming.
  if (avatar !== undefined || avatarReset) {
    try {
      const t = resolveTranscript(null);
      const dest = setAvatar(avatarReset ? null : avatar, t && t.file);
      const drawn = redrawCards().length;
      const msg = dest ? `Avatar set. Redrew ${drawn} cards.` : `Avatar removed — cards show the initial again. Redrew ${drawn} cards.`;
      if (name === undefined) return text(msg);
      var avatarNote = '\n' + msg;
    } catch (err) { return text(`Avatar failed: ${err.message}`); }
  }
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) return text('Give a name, e.g. set_athlete with name "Ada".');
  const previous = config().athlete || '(unset)';
  setConfig({ athlete: clean });

  // The athlete is a property of the account, so past cards should agree.
  const db = load();
  let n = 0;
  for (const a of db.activities) { if (a.athlete !== clean) { a.athlete = clean; n++; } }
  save(db);
  return text(`Athlete set to "${clean}" (was ${previous}). Updated ${n} stored ` +
    `activit${n === 1 ? 'y' : 'ies'} — run \`node scripts/rerender.js\` to redraw the cards.` +
    (typeof avatarNote === 'string' ? avatarNote : ''));
}

// Card results end with the options that apply to that card, so the follow-ups
// are discoverable without reading the README.
const nextSteps = (items) => {
  const list = items.filter(Boolean);
  // Phrased as an offer, because the point is for the assistant to ask rather
  // than leave the options sitting unread in a tool result.
  return list.length ? `\nOffer the user: ${list.join(' · ')}` : '';
};

function snap(kind, { period, title, hide_projects: hideProjects = false, pick } = {}) {
  let bounds;
  try { bounds = resolvePeriod(kind, period); } catch (err) { return text(err.message); }
  const s = summarize(presentAll(), bounds, { pick });
  if (pick && !(s.feature && s.feature.selected)) return text(`No session matching "${pick}" in that ${kind}.`);

  const svg = kind === 'week' ? renderWeekly(s, { title, hideProjects }) : renderMonthly(s, { title, hideProjects });
  const key = ['snap', kind, dayKey(bounds.start.getTime()), bounds.rolling ? `r${bounds.rolling}` : '', hideProjects ? 'anon' : '', title ? 'titled' : '']
    .filter(Boolean).join('-');
  const { pngPath, svgPath, png } = writeCard(key, svg);

  const lines = [
    bounds.rolling
      ? `Last ${bounds.rolling} days to ${dayKey(Date.now())}`
      : `${kind === 'week' ? 'Week' : 'Month'} of ${dayKey(bounds.start.getTime())}${s.partial ? ' (so far)' : ''}`,
    `${s.sessions} sessions · ${s.activeDays} active days · ${s.projectCount} projects · ${fmtHM(s.moving)} agent time (summed across parallel sessions)`,
    `${s.toolCalls.toLocaleString('en-US')} tool calls · ${s.costCoverage.priced ? 'est. ' + fmtUsd(s.cost) : 'no cost recorded'}` +
      (s.costCoverage.priced < s.costCoverage.of ? ` (partial: ${s.costCoverage.priced} of ${s.costCoverage.of} sessions priced)` : ''),
    s.feature ? `${s.feature.selected ? "Pick" : 'Longest session'}: ${s.feature.activity.title} · ${fmtHM(s.feature.seconds)}` : 'No recorded sessions.',
    `Card: ${pngPath || svgPath}`,
    nextSteps([
      s.projectCount && !hideProjects ? 'rename or hide a project name before sharing (rename_project · hide_projects)' : '',
      kind === 'month' && s.feature && !s.feature.selected ? 'feature a different session (pick)' : '',
      title ? '' : 'write their own headline (title)',
      period ? '' : `a rolling window instead of a part-finished ${kind} (period: "${kind === 'week' ? 'last7' : 'last30'}")`,
    ]),
  ];
  const content = [{ type: 'text', text: lines.join('\n') }];
  if (png) content.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
  return { content };
}

function menu() {
  const acts = presentAll();
  const projects = listProjects(acts);
  const latest = acts.slice().sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0];
  const you = config().athlete || 'Athlete (set one with set_athlete)';

  return text([
    `AGENTRAVA — ${you} · ${acts.length} activities · ${streak(acts)}-day streak · ${projects.length} projects`,
    latest ? `Last logged: ${latest.title}${latest.project_name ? ' · ' + latest.project_name : ''} (${new Date(latest.date).toLocaleDateString('en-CA')})` : 'Nothing logged yet.',
    '',
    'MAKE A CARD',
    '  snapshot            the session running right now, measured from its transcript',
    '  weekly_snap         a week — period: "this" | "last" | "last7" (rolling, always complete)',
    '  monthly_snap        a month — period: "this" | "last" | "last30" | "2026-08"',
    '  recap               everything logged, or a from/to range',
    '',
    'BEFORE YOU SHARE',
    '  photo: "chat"       put an image you paste into this chat behind the route (snapshot)',
    '  set_athlete         your name, and avatar: "chat" for the picture in the circle',
    '  title: "…"          your own headline or session name',
    '  rename_session      rename a session; reset: true restores the generated one',
    '  rename_project      rename a project, or hidden: true to keep its name off cards',
    '  hide_projects       one-off: show "Project A/B" on a snap instead of real names',
    '',
    'LOOK BACK',
    '  get_profile · list_activities · leaderboard · list_projects',
    '',
    'Ask the user which they want if it is not obvious from what they said.',
  ].join('\n'));
}

function renameSessionTool({ session, title, reset } = {}) {
  try {
    if (!reset && title === undefined) return text('Give a title, or reset: true.');
    const r = renameSession(session, reset ? null : title);
    return text((r.reset ? `Reset to "${r.after}".` : `"${r.before}" → "${r.after}".`) +
      `\nRedrew ${r.cards.length} card${r.cards.length === 1 ? '' : 's'}.`);
  } catch (err) { return text(err.message); }
}

function renameProjectTool({ project, name, reset, hidden } = {}) {
  try {
    const opts = {};
    if (reset) opts.name = null; else if (name !== undefined) opts.name = name;
    if (hidden !== undefined) opts.hidden = hidden;
    const r = renameProject(project, opts);
    return text(`"${r.before}" → "${r.after}"${r.hidden ? ' (hidden on cards)' : ''}.` +
      `\nRedrew ${r.cards.length} card${r.cards.length === 1 ? '' : 's'}.`);
  } catch (err) { return text(err.message); }
}

function listProjectsTool() {
  const list = listProjects();
  return text(list.length ? list.map(describeProject).join('\n') : 'No projects recorded yet.');
}

function getProfile({ athlete } = {}) {
  let acts = presentAll();
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
  let acts = presentAll();
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

  const acts = presentAll().sort((a, b) => get(b) - get(a)).slice(0, Math.max(1, Math.min(50, limit)));
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
      case 'agentrava':       return menu();
      case 'rename_session':  return renameSessionTool(args);
      case 'rename_project':  return renameProjectTool(args);
      case 'list_projects':   return listProjectsTool();
      case 'weekly_snap':     return snap('week', args);
      case 'monthly_snap':    return snap('month', args);
      case 'set_athlete':     return setAthlete(args);
      case 'snapshot':        return await snapshot(args);
      case 'list_activities': return listActivities(args);
      case 'leaderboard':     return leaderboard(args);
      default: return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `agentrava failed: ${err.message}` }] };
  }
});

await server.connect(new StdioServerTransport());
