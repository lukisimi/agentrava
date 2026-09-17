// Renaming sessions and projects, shared by the CLI and the MCP server.
//
// Both are presentation, stored beside the measured data rather than in it:
// session titles in overrides.json, project display names in projects.json. So
// a re-log or a forced backfill keeps them, and a reset always restores the
// generated name. An ambiguous prefix is refused rather than guessed.
import { presentAll, setOverride, overrideKey, setProject } from './store.js';
import { redrawCards } from './redraw.js';
import { fmtHM } from './summary.js';

const MAX = 60;

function cleanName(value, what) {
  const v = String(value ?? '').trim();
  if (!v) throw new Error(`${what} is empty — reset it instead to restore the default.`);
  if (v.length > MAX) throw new Error(`Keep ${what.toLowerCase()}s to ${MAX} characters (this one is ${v.length}).`);
  return v;
}

const sessionLine = (a) =>
  `  ${(a.session_id || a.id).slice(0, 8)}  ${new Date(a.date).toLocaleDateString('en-CA')}  ${a.title}${a.project_name ? ' · ' + a.project_name : ''}`;

export function findSession(query, acts = presentAll()) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Give a session id or id prefix.');
  const hits = acts.filter((a) => a.id === q || a.id.startsWith(q) || (a.session_id || '').startsWith(q));
  if (!hits.length) throw new Error(`No session matching "${q}".`);
  const exact = hits.filter((a) => a.id === q || a.session_id === q);
  if (exact.length === 1) return exact[0];
  if (hits.length > 1) {
    throw new Error(`"${q}" matches ${hits.length} sessions — use a longer prefix:\n${hits.slice(0, 8).map(sessionLine).join('\n')}`);
  }
  return hits[0];
}

export function listProjects(acts = presentAll()) {
  const byId = new Map();
  for (const a of acts) {
    if (!a.project_id) continue;
    const p = byId.get(a.project_id) || {
      id: a.project_id, path: a.repo_path || null, repo: a.repo, name: a.project_name,
      hidden: a.project_hidden, sessions: 0, seconds: 0,
    };
    p.sessions++;
    p.seconds += a.duration_seconds || 0;
    byId.set(a.project_id, p);
  }
  return [...byId.values()].sort((x, y) => y.seconds - x.seconds);
}

export function findProject(query, acts = presentAll()) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Give a project name or path.');
  const lower = q.toLowerCase();
  const hits = listProjects(acts).filter((p) =>
    p.id === q || p.path === q || (p.repo || '').toLowerCase() === lower || (p.name || '').toLowerCase() === lower);
  if (!hits.length) throw new Error(`No project matching "${q}". List them with list_projects.`);
  if (hits.length > 1) {
    throw new Error(`"${q}" matches ${hits.length} different projects — pass the path instead:\n` +
      hits.map((p) => `  ${p.path || p.id}  (${p.sessions} sessions)`).join('\n'));
  }
  return hits[0];
}

// title null -> back to the generated title.
export function renameSession(query, title) {
  const a = findSession(query);
  const next = title === null ? null : cleanName(title, 'Title');
  setOverride(overrideKey(a), { title: next });
  const cards = redrawCards((x) => x.id === a.id);
  return { before: a.title, after: next ?? a.generated_title, reset: next === null, session: a, cards };
}

// name null -> back to the repository name; hidden true -> keep it off cards.
export function renameProject(query, { name, hidden } = {}) {
  const p = findProject(query);
  const patch = {};
  if (name !== undefined) patch.name = name === null ? null : cleanName(name, 'Name');
  if (hidden !== undefined) patch.hidden = Boolean(hidden);
  if (!Object.keys(patch).length) throw new Error('Nothing to change — give a name, reset, or hidden.');
  setProject(p.id, patch);
  const cards = redrawCards((a) => a.project_id === p.id);
  const after = presentAll().find((a) => a.project_id === p.id);
  return { before: p.name, after: after ? after.project_name : p.repo, hidden: after ? after.project_hidden : false, project: p, cards };
}

export const describeProject = (p) =>
  `${p.name}${p.name !== p.repo ? `  (renamed from ${p.repo})` : ''}${p.hidden ? '  [hidden on cards]' : ''}\n` +
  `    ${p.sessions} sessions · ${fmtHM(p.seconds)} · ${p.path || 'no path recorded yet — re-log to add one'}`;
