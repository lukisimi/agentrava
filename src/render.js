import fs from 'node:fs';
import path from 'node:path';
import { CARDS_DIR } from './store.js';

let Resvg = null;
try { ({ Resvg } = await import('@resvg/resvg-js')); } catch { /* SVG-only fallback */ }

export function writeCard(id, svg) {
  fs.mkdirSync(CARDS_DIR, { recursive: true });
  const svgPath = path.join(CARDS_DIR, `${id}.svg`);
  fs.writeFileSync(svgPath, svg);

  if (!Resvg) return { svgPath, pngPath: null, png: null };
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1080 },
    font: { loadSystemFonts: true, defaultFontFamily: 'Helvetica Neue' },
  }).render().asPng();
  const pngPath = path.join(CARDS_DIR, `${id}.png`);
  fs.writeFileSync(pngPath, png);
  return { svgPath, pngPath, png };
}
