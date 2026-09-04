// Which tool a session ran in. Cards name the product in text, which is ordinary
// nominative use; logo artwork is a trademark owned by each company and is NOT
// bundled here. Drop your own file at ~/.agentrava/logos/<client>.(svg|png) and
// it is used instead of the wordmark — sourcing it, and honouring the relevant
// brand guidelines, is the user's call rather than something this repo decides.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './store.js';

export const LOGO_DIR = path.join(HOME, 'logos');

export const CLIENTS = {
  'claude-code': { label: 'Claude Code', tint: '#d97757' },
  claude:        { label: 'Claude',      tint: '#d97757' },
  cursor:        { label: 'Cursor',      tint: '#e8e8e8' },
  openai:        { label: 'OpenAI',      tint: '#10a37f' },
  codex:         { label: 'Codex',       tint: '#10a37f' },
  grok:          { label: 'Grok',        tint: '#ffffff' },
  copilot:       { label: 'Copilot',     tint: '#8957e5' },
  windsurf:      { label: 'Windsurf',    tint: '#58c4a5' },
  zed:           { label: 'Zed',         tint: '#4a9eff' },
};

export function clientInfo(id) {
  if (!id) return null;
  const key = String(id).toLowerCase();
  const meta = CLIENTS[key] || { label: String(id), tint: '#8b93a3' };
  return { key, ...meta, logo: findLogo(key) };
}

// Returns a data URI when the user has supplied artwork, else null.
function findLogo(key) {
  for (const ext of ['svg', 'png']) {
    const f = path.join(LOGO_DIR, `${key}.${ext}`);
    try {
      if (!fs.existsSync(f)) continue;
      const st = fs.statSync(f);
      if (st.size > 512 * 1024) continue;            // a logo is not a megabyte
      const mime = ext === 'svg' ? 'image/svg+xml' : 'image/png';
      return `data:${mime};base64,${fs.readFileSync(f).toString('base64')}`;
    } catch { /* unreadable; fall back to the wordmark */ }
  }
  return null;
}
