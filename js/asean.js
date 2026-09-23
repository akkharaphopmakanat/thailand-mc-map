// Lower-detail backdrop of all ASEAN (0.05° blocks, ~5.5 km) drawn under the detailed Thailand
// map in the same Minecraft-map style: real terrain relief, sea depth, darkened country borders.
import { B } from './config.js';
import { h2 } from './noise.js';
import { decodeRows } from './rle.js';

/**
 * Decode data/asean.json (+ its elevation PNG, already decoded to metres) into
 * {W, H, S, lon0, lat1, grid (0 sea, 1–11 ASEAN country, 12 other land), elev, countries}.
 */
export function decodeAsean(json, elev) {
  const symbols = Object.keys(json.symbols);            // '.', ',', 'A', 'B', …
  const asean = symbols.filter(s => s.length === 1 && s >= 'A' && s <= 'Z').sort();
  const map = { '.': 0, ',': asean.length + 1 };
  asean.forEach((s, i) => { map[s] = i + 1; });
  const grid = decodeRows(json.rows, json.W, json.H, '', map);
  return { ...json, grid, elev, other: asean.length + 1 };
}

const THAI = 1;                                          // Thailand is the first country in the list

/** Paint the backdrop, one pixel per block. Returns a canvas W × H. */
export function renderAsean(a) {
  const { W, H, grid, elev } = a;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const x = cv.getContext('2d');
  const img = x.createImageData(W, H), px = img.data;
  const level = k => Math.floor(Math.max(elev ? elev[k] : 0, 0) / 120);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const k = r * W + c, v = grid[k], e = elev ? elev[k] : 0;
    let rgb;
    if (v === 0) {
      const d = Math.max(-e, 1);
      rgb = d <= 30 ? [74, 122, 226] : d <= 200 ? (((r + c) & 1) ? [62, 104, 214] : [58, 96, 206])
        : d <= 1500 ? [50, 82, 192] : (((r + c) & 1) && d <= 3000 ? [46, 74, 180] : [40, 64, 166]);
    } else {
      const coast = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dr, dc]) => grid[(r + dr) * W + c + dc] === 0);
      rgb = e > 4500 ? [236, 240, 244] : e > 2200 ? [132, 132, 134] : coast && e < 30 ? [222, 208, 160]
        : e > 900 ? [70, 112, 50] : [92, 142, 60];
      if (v !== THAI) {                                  // neighbours: slightly muted, like the detailed map
        const g = (rgb[0] + rgb[1] + rgb[2]) / 3;
        rgb = rgb.map(q => (q * .7 + g * .3) * (v === a.other ? .62 : .82));
      }
      // Minecraft map relief: brighter when higher than the block to the north
      if (r > 0 && grid[k - W] !== 0) { const l = level(k), n = level(k - W); rgb = rgb.map(q => q * (l > n ? 1.12 : l < n ? .84 : 1)); }
      // country borders
      const nb = [grid[k - 1], grid[k + 1], grid[k - W], grid[k + W]];
      if (nb.some(u => u > 0 && u !== v)) rgb = rgb.map(q => q * .55);
    }
    const n = .94 + h2(c, r, 7) * .12, o = k * 4;
    px[o] = Math.min(255, rgb[0] * n); px[o + 1] = Math.min(255, rgb[1] * n); px[o + 2] = Math.min(255, rgb[2] * n); px[o + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  return cv;
}

/** Where the backdrop sits in the detailed map's world pixels: [x, y, width, height]. */
export function aseanRect(a, map) {
  const k = B / map.S;                                  // world px per degree
  return [(a.lon0 - map.lon0) * k, (map.lat1 - a.lat1) * k, a.W * a.S * k, a.H * a.S * k];
}

/** Country name under a world-pixel point, or ''. */
export function countryAt(a, map, wx, wy) {
  const [x0, y0, w, h] = aseanRect(a, map);
  const c = Math.floor((wx - x0) / w * a.W), r = Math.floor((wy - y0) / h * a.H);
  if (c < 0 || r < 0 || c >= a.W || r >= a.H) return '';
  const v = a.grid[r * a.W + c];
  return v >= 1 && v <= a.countries.length ? a.countries[v - 1].name : v ? 'Other land' : '';
}
