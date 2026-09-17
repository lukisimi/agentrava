// A profile picture for the circle that otherwise holds an initial. Stored in
// config as a path inside ~/.agentrava, copied there on set so moving or
// deleting the original does not blank every card.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { HOME, config, setConfig } from './store.js';
import { photoDataUri, resolvePhotoPath } from './photo.js';

const AVATARS = path.join(HOME, 'avatars');
let cache = null;

// Data URI for the stored avatar, or null. Cached per process: every card in a
// redraw would otherwise re-read and re-encode the same file.
export function avatarUri() {
  const file = config().avatar;
  if (!file) return null;
  if (cache && cache.file === file) return cache.uri;
  try {
    const uri = photoDataUri(file);
    cache = { file, uri };
    return uri;
  } catch { return null; }
}

// spec: a file path, "chat" for the image most recently pasted into the
// conversation, or null to clear.
export function setAvatar(spec, transcriptPath) {
  if (spec === null) { setConfig({ avatar: null }); cache = null; return null; }
  const src = resolvePhotoPath(spec, transcriptPath);
  photoDataUri(src);                                   // validates type and size
  fs.mkdirSync(AVATARS, { recursive: true });
  const buf = fs.readFileSync(src);
  const dest = path.join(AVATARS, createHash('sha1').update(buf).digest('hex').slice(0, 12) + path.extname(src).toLowerCase());
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf);
  setConfig({ avatar: dest });
  cache = null;
  return dest;
}

// The circle, with the picture in it when there is one. id must be unique per SVG.
export function avatarSvg({ cx, cy, r, initial, accent, ink, id = 'avatar' }) {
  const uri = avatarUri();
  if (!uri) {
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${accent}" fill-opacity="0.18"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${accent}" stroke-opacity="0.5" stroke-width="2"/>
  <text x="${cx}" y="${cy + r * 0.34}" fill="${accent}" font-size="${(r * 0.97).toFixed(0)}" font-weight="700" text-anchor="middle">${initial}</text>`;
  }
  return `<clipPath id="${id}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>
  <image href="${uri}" x="${cx - r}" y="${cy - r}" width="${r * 2}" height="${r * 2}" clip-path="url(#${id})" preserveAspectRatio="xMidYMid slice"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${accent}" stroke-opacity="0.6" stroke-width="2"/>`;
}
