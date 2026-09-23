// Turns a province's 16×16 `item.sprite` rows into an 18×18 canvas (with a 1px outline) and data URL.
import { PAL } from './config.js';

const cache = new Map();

/** @returns {{canvas: HTMLCanvasElement, url: string}} */
export function itemSprite(province) {
  const key = province.slug;
  if (cache.has(key)) return cache.get(key);
  const rows = province.item?.sprite || [];
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 18;
  const x = canvas.getContext('2d');
  const on = new Uint8Array(18 * 18);
  for (let r = 0; r < 16; r++) {
    const row = (rows[r] || '').padEnd(16, '.');
    for (let c = 0; c < 16; c++) {
      const col = PAL[row[c]];
      if (!col) continue;
      x.fillStyle = col;
      x.fillRect(c + 1, r + 1, 1, 1);
      on[(r + 1) * 18 + c + 1] = 1;
    }
  }
  // Soft dark outline so items read on any terrain
  x.fillStyle = 'rgba(20,14,10,.55)';
  for (let r = 0; r < 18; r++) {
    for (let c = 0; c < 18; c++) {
      if (on[r * 18 + c]) continue;
      if ((c > 0 && on[r * 18 + c - 1]) || (c < 17 && on[r * 18 + c + 1]) ||
          (r > 0 && on[(r - 1) * 18 + c]) || (r < 17 && on[(r + 1) * 18 + c])) x.fillRect(c, r, 1, 1);
    }
  }
  const out = { canvas, url: canvas.toDataURL() };
  cache.set(key, out);
  return out;
}
