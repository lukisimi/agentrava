// Attach a photo to an activity, Strava-style: it becomes the map background and
// the route is drawn over it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp',
};
const MAX_BYTES = 8 * 1024 * 1024;   // embedded as base64, so it inflates ~33%

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };

// An image pasted into the chat never becomes a file — Claude Code stores it as
// base64 inside the session transcript. Recover the most recent one so "use the
// picture I just sent" works without the user saving it anywhere first.
export function latestPastedImage(transcriptPath, outDir) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('"base64"')) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'user') continue;                     // only what the human sent
    const content = (d.message || {}).content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      const src = b && b.type === 'image' ? b.source : null;
      if (!src || src.type !== 'base64' || !src.data) continue;
      const ext = EXT[src.media_type] || '.png';
      const buf = Buffer.from(src.data, 'base64');
      fs.mkdirSync(outDir, { recursive: true });
      // Name by content, so pasting the same image twice reuses one file.
      const name = createHash('sha1').update(buf).digest('hex').slice(0, 12) + ext;
      const out = path.join(outDir, name);
      if (!fs.existsSync(out)) fs.writeFileSync(out, buf);
      return { path: out, bytes: buf.length, mediaType: src.media_type, at: d.timestamp || null };
    }
  }
  return null;
}

export function photoDataUri(file) {
  if (!file) return null;
  const abs = path.resolve(file.replace(/^~(?=\/)/, process.env.HOME || '~'));
  if (!fs.existsSync(abs)) throw new Error(`no such photo: ${abs}`);
  const mime = MIME[path.extname(abs).toLowerCase()];
  if (!mime) throw new Error(`unsupported image type: ${path.extname(abs)} (jpg, png, gif, webp)`);
  const st = fs.statSync(abs);
  if (st.size > MAX_BYTES) {
    throw new Error(`photo is ${(st.size / 1048576).toFixed(1)} MB; keep it under 8 MB`);
  }
  return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
}

export const PHOTO_DIR = path.join(os.homedir(), '.agentrava', 'photos');

// Accepts a file path, or the keyword "chat" meaning the image most recently
// pasted into the session.
export function resolvePhotoPath(spec, transcriptPath) {
  if (!spec) return null;
  if (!['chat', 'pasted', 'latest'].includes(String(spec).toLowerCase())) {
    return path.resolve(String(spec).replace(/^~(?=\/)/, os.homedir()));
  }
  const img = latestPastedImage(transcriptPath, PHOTO_DIR);
  if (!img) throw new Error('no image found in this conversation — paste one, then try again');
  return img.path;
}
