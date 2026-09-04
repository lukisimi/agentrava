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
  else db.activities[i] = { ...activity, id: db.activities[i].id, date: db.activities[i].date };
  save(db);
  return { created, activity: created ? activity : db.activities[i] };
  });
}
