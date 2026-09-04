import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const HOME = process.env.AGENTRAVA_HOME || path.join(os.homedir(), '.agentrava');
export const CARDS_DIR = path.join(HOME, 'cards');
const DB = path.join(HOME, 'activities.json');

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
  const tmp = DB + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB);
}

export function append(activity) {
  const db = load();
  db.activities.push(activity);
  save(db);
  return db;
}

export function all() {
  return load().activities;
}

// A session is logged repeatedly as it grows, so the hook replaces its own
// earlier entry instead of stacking one activity per turn.
export function upsertBySession(sessionId, activity) {
  const db = load();
  const i = db.activities.findIndex((a) => a.session_id && a.session_id === sessionId);
  const created = i < 0;
  if (created) db.activities.push(activity);
  else db.activities[i] = { ...activity, id: db.activities[i].id, date: db.activities[i].date };
  save(db);
  return { created, activity: created ? activity : db.activities[i] };
}
