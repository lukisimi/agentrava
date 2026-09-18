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

// Read at most the last `cap` bytes of a file as lines. Session logs run to
// hundreds of megabytes; a pasted image is near the end of one by definition.
const TAIL_BYTES = 64 * 1024 * 1024;
function tailLines(file, cap = TAIL_BYTES) {
  const size = fs.statSync(file).size;
  if (size <= cap) return fs.readFileSync(file, 'utf8').split('\n');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(cap);
    fs.readSync(fd, buf, 0, cap, size - cap);
    const lines = buf.toString('utf8').split('\n');
    lines.shift();                                       // first line is a fragment
    return lines;
  } finally { try { fs.closeSync(fd); } catch { /* already gone */ } }
}

// A user message carrying an image, in either client's shape. Claude Code writes
// `{type:'image', source:{type:'base64', media_type, data}}`; Codex writes
// `{type:'input_image', image_url:'data:image/png;base64,...'}`.
function pastedIn(line) {
  let d;
  try { d = JSON.parse(line); } catch { return null; }
  if (d.type === 'user' && d.message) {
    const content = d.message.content;
    if (!Array.isArray(content)) return null;
    const hit = content.filter((b) => b && b.type === 'image' && b.source
      && b.source.type === 'base64' && b.source.data).pop();
    return hit ? { data: hit.source.data, mediaType: hit.source.media_type, at: d.timestamp || null } : null;
  }
  const p = d.payload;
  if (!p || p.type !== 'message' || p.role !== 'user' || !Array.isArray(p.content)) return null;
  const hit = p.content.filter((b) => b && b.type === 'input_image'
    && typeof b.image_url === 'string' && b.image_url.startsWith('data:image/')).pop();
  if (!hit) return null;
  const m = hit.image_url.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
  return m ? { data: m[2], mediaType: m[1], at: d.timestamp || null } : null;
}

// An image pasted into the chat never becomes a file — both Claude Code and Codex
// store it as base64 inside the session log. Recover the most recent one so "use
// the picture I just sent" works without the user saving it anywhere first.
export function latestPastedImage(transcriptPath, outDir) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  const lines = tailLines(transcriptPath);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || (!line.includes('"base64"') && !line.includes('data:image/'))) continue;
    const src = pastedIn(line);
    if (src) {
      const ext = EXT[src.mediaType] || '.png';
      const buf = Buffer.from(src.data, 'base64');
      fs.mkdirSync(outDir, { recursive: true });
      // Name by content, so pasting the same image twice reuses one file.
      const name = createHash('sha1').update(buf).digest('hex').slice(0, 12) + ext;
      const out = path.join(outDir, name);
      if (!fs.existsSync(out)) fs.writeFileSync(out, buf);
      return { path: out, bytes: buf.length, mediaType: src.mediaType, at: src.at };
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

// Data URI for an activity's photo, or null. A photo that has since moved or been
// deleted should cost the card its background, not the whole render.
export function photoFor(a) {
  try { return a && a.photo ? photoDataUri(a.photo) : null; } catch { return null; }
}
