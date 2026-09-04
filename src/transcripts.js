// Finding Claude Code session transcripts on disk. Shared by the CLI and the
// MCP server so "the current session" means the same thing in both.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

// Transcripts are not all one level deep — worktree sessions sit deeper.
export function findTranscripts(dir = PROJECTS, out = [], depth = 0) {
  if (depth > 4) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findTranscripts(full, out, depth + 1);
    else if (e.name.endsWith('.jsonl')) {
      try {
        const st = fs.statSync(full);
        out.push({ id: e.name.slice(0, -6), file: full, mtime: st.mtimeMs, size: st.size });
      } catch { /* vanished mid-scan */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// Read the working directory a transcript recorded, from its first few lines.
function cwdOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.slice(0, n).toString('utf8').split('\n')) {
      if (!line.includes('"cwd"')) continue;
      try { const d = JSON.parse(line); if (d.cwd) return d.cwd; } catch { /* partial line */ }
    }
  } catch { /* unreadable */ } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  return null;
}

// Which transcript is "the current session"?
//
// Claude Code gives an MCP server no session id — CLAUDE_CODE_HOST_SESSION_ID is a
// host-level id with no transcript of its own — so this is a heuristic, not a fact.
// Most-recently-written alone picks the wrong session whenever another one is
// active, so prefer a transcript whose recorded cwd matches where this server was
// started, and fall back to plain recency. Callers should report which session
// was chosen so a wrong guess is visible.
export function resolveTranscript(idPrefix, cwd = process.cwd()) {
  const list = findTranscripts();
  if (!list.length) return null;
  if (idPrefix) {
    const hit = list.find((t) => t.id.startsWith(idPrefix));
    return hit ? { ...hit, why: 'requested' } : null;
  }
  for (const t of list.slice(0, 12)) {
    if (cwdOf(t.file) === cwd) return { ...t, why: 'cwd match' };
  }
  return { ...list[0], why: 'most recently written' };
}
