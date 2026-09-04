// Attach a photo to an activity, Strava-style: it becomes the map background and
// the route is drawn over it.
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp',
};
const MAX_BYTES = 8 * 1024 * 1024;   // embedded as base64, so it inflates ~33%

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
