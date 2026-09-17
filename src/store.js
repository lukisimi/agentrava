import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const HOME = process.env.AGENTRAVA_HOME || path.join(os.homedir(), '.agentrava');
export const CARDS_DIR = path.join(HOME, 'cards');
const DB = path.join(HOME, 'activities.json');
const CONFIG = path.join(HOME, 'config.json');

// Cards are made to be shared, so anything that reproduces raw prompt text is
// opt-outable in one place.
export function config() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}
export function setConfig(patch) {
  fs.mkdirSync(HOME, { recursive: true });
  const next = { ...config(), ...patch };
  fs.writeFileSync(CONFIG, JSON.stringify(next, null, 2) + '\n');
  return next;
}

function ensure() {
  fs.mkdirSync(CARDS_DIR, { recursive: true });
  if (!fs.existsSync(DB)) fs.writeFileSync(DB, JSON.stringify({ version: 1, activities: [] }, null, 2));
}

export function load() {
  ensure();
  try {
    const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
    if (!Array.isArray(db.activities)) db.activities = [];
    return db;
  } catch {
    // A corrupt db should never cost the user their history silently.
    const backup = DB + '.corrupt-' + Date.now();
    try { fs.copyFileSync(DB, backup); } catch {}
    return { version: 1, activities: [] };
  }
}

export function save(db) {
  ensure();
  // Unique per process: a shared temp name lets one writer rename the file out
  // from under another, which fails with ENOENT instead of just losing a write.
  const tmp = `${DB}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* already renamed */ }
  }
}

// Every session's Stop hook writes this file, so concurrent sessions collide on
// read-modify-write and silently drop each other's activities. mkdir is atomic on
// POSIX, so it makes a serviceable cross-process mutex.
const LOCK = path.join(HOME, '.lock');
const LOCK_STALE_MS = 15000;

export function withLock(fn, { timeoutMs = 10000 } = {}) {
  ensure();
  const start = Date.now();
  let held = false;
  while (Date.now() - start < timeoutMs) {
    try { fs.mkdirSync(LOCK); held = true; break; } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // A crashed writer must not block everyone forever.
      try {
        if (Date.now() - fs.statSync(LOCK).mtimeMs > LOCK_STALE_MS) { fs.rmdirSync(LOCK); continue; }
      } catch { /* vanished between stat and rmdir */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 + Math.random() * 20);
    }
  }
  // Losing the lock race is not a reason to lose the write; proceed unlocked.
  try { return fn(); } finally { if (held) { try { fs.rmdirSync(LOCK); } catch { /* gone */ } } }
}

export function append(activity) {
  return withLock(() => {
    const db = load();
    db.activities.push(activity);
    save(db);
    return db;
  });
}

export function all() {
  return load().activities;
}

// A session is logged repeatedly as it grows, so the hook replaces its own
// earlier entry instead of stacking one activity per turn.
export function upsertBySession(sessionId, activity) {
  return withLock(() => {
  const db = load();
  const i = db.activities.findIndex((a) => a.session_id && a.session_id === sessionId);
  const created = i < 0;
  if (created) db.activities.push(activity);
  // Keep the id so the route stays the same trace, but take the new date: an
  // activity is dated by when its work ended, which moves as the session grows.
  else db.activities[i] = { ...activity, id: db.activities[i].id,
                            date: activity.date || db.activities[i].date };
  save(db);
  return { created, activity: created ? activity : db.activities[i] };
  });
}

// Presentation choices — photo, route placement — live apart from measured data.
// activities.json is rebuilt by every forced backfill and replaced by every
// re-log; this file is touched by neither, so a photo set once stays set.
const OVERRIDES = path.join(HOME, 'overrides.json');
// title is a user rename; clearing it restores the generated title.
export const PRESENTATION_KEYS = ['photo', 'route', 'title'];

export const overrideKey = (a) => a.session_id || a.id;

export function overrides() {
  try { return JSON.parse(fs.readFileSync(OVERRIDES, 'utf8')); } catch { return {}; }
}

// null removes a key; an entry with no keys left is dropped.
export function setOverride(key, patch) {
  return withLock(() => {
    const table = overrides();
    const cur = { ...(table[key] || {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (!PRESENTATION_KEYS.includes(k)) continue;
      if (v === null || v === undefined) delete cur[k]; else cur[k] = v;
    }
    if (Object.keys(cur).length) table[key] = cur; else delete table[key];
    ensure();
    const tmp = `${OVERRIDES}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tmp, JSON.stringify(table, null, 2));
    fs.renameSync(tmp, OVERRIDES);
    return cur;
  });
}

/* ---------------- projects ---------------- */

// A project is identified by its repository root path, never by its name: two
// repositories both called "web" are different projects, and giving two
// projects the same display name must not merge them. Activities logged before
// paths were recorded fall back to a name-scoped id until they are re-logged.
const PROJECTS = path.join(HOME, 'projects.json');

export const projectId = (a) => (a.repo_path ? a.repo_path : a.repo ? `name:${a.repo}` : null);

export function projectsTable() {
  try { return JSON.parse(fs.readFileSync(PROJECTS, 'utf8')); } catch { return {}; }
}

// patch.name: display name (null resets); patch.hidden: keep it off shared cards.
export function setProject(id, patch) {
  return withLock(() => {
    const table = projectsTable();
    const cur = { ...(table[id] || {}) };
    if ('name' in patch) { if (patch.name) cur.name = patch.name; else delete cur.name; }
    if ('hidden' in patch) { if (patch.hidden) cur.hidden = true; else delete cur.hidden; }
    if (Object.keys(cur).length) table[id] = cur; else delete table[id];
    ensure();
    const tmp = `${PROJECTS}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tmp, JSON.stringify(table, null, 2));
    fs.renameSync(tmp, PROJECTS);
    return cur;
  });
}

/* ---------------- presentation ---------------- */

function present(a, ov, pj) {
  const legacy = {};
  for (const k of PRESENTATION_KEYS) if (a[k] !== undefined) legacy[k] = a[k];
  const out = { ...a, ...legacy, ...(ov[overrideKey(a)] || {}) };
  // Keep the generated title reachable, so a rename can always be undone.
  out.generated_title = a.title;
  const id = projectId(a);
  const proj = (id && pj[id]) || {};
  out.project_id = id;
  out.project_name = proj.name || a.repo || '';
  out.project_hidden = Boolean(proj.hidden);
  return out;
}

// The activity as it should be shown: renamed title, project display name,
// photo and route. The measured record underneath is never modified.
export function withPresentation(a) {
  return present(a, overrides(), projectsTable());
}

// Same, for many activities, reading each table once.
export function presentAll(list = all()) {
  const ov = overrides(), pj = projectsTable();
  return list.map((a) => present(a, ov, pj));
}
