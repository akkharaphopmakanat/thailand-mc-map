// Per-block terrain classification (shared by the 2D and 3D views) and the 2D terrain canvas.
import { B, REGIONS, SHADES } from './config.js';
import { h2, vn, fbm } from './noise.js';

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export const KIND = { GRASS: 0, WATER: 1, SAND: 2, STONE: 3, TREE: 4, PADDY: 5, FOREIGN_TREE: 6, FOREIGN: 7 };
const K = KIND;

/**
 * Classify every block: what it is, its base colour and its height in metres.
 * Uses real elevation when available, otherwise generated relief.
 * @returns {{kind: Uint8Array, col: Float32Array, elev: Float32Array}}
 */
export function classifyCells({ map, grid, provinces, elev: realElev }) {
  const { W, H } = map;
  const N = W * H;
  const kind = new Uint8Array(N), col = new Float32Array(N * 3), elev = new Float32Array(N);

  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const k = r * W + c, v = grid[k];
    const reg = v >= 0 ? provinces[v].region : null;
    const R = reg ? REGIONS[reg] : null;
    let e = realElev ? realElev[k] : (v === -1 ? -60 : fbm(c, r, 11) * (R ? R.amp : .55) * 1800);
    let rgb, kd = K.GRASS;
    if (v === -1) {
      e = Math.min(e, -2);
      const d = -e;
      rgb = d <= 15 ? [74, 122, 226] : d <= 40 ? (((r + c) & 1) ? [62, 104, 214] : [58, 96, 206])
        : d <= 120 ? [50, 82, 192] : (((r + c) & 1) && d <= 600 ? [46, 74, 180] : [40, 64, 166]);
      kd = K.WATER;
    } else {
      e = Math.max(e, 1);
      let coast = false;
      for (const [dr, dc] of DIRS) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && cc >= 0 && rr < H && cc < W && grid[rr * W + cc] === -1) { coast = true; break; }
      }
      // Forest is denser on high ground
      const tree = vn(c / 6, r / 6, 5) > (R ? R.forest : .5) - Math.min(e, 1500) / 3000 && h2(c, r, 6) < .6;
      if (coast && e < 40) { rgb = [222, 208, 160]; kd = K.SAND; }
      else if (e > 1350 + h2(c, r, 7) * 250) { rgb = [132, 132, 134]; kd = K.STONE; }
      else if (tree) { const b = R ? R.base : [92, 118, 70]; rgb = [b[0] * .66, b[1] * .7, b[2] * .66]; kd = K.TREE; }
      else if (reg === 'C' && e < 60 && vn(c / 5, r / 5, 21) > .48) { rgb = [126, 186, 78]; kd = K.PADDY; }
      else if (reg === 'NE' && vn(c / 4, r / 4, 31) > .7) rgb = [136, 100, 64];
      else rgb = R ? R.base.slice() : [92, 118, 70];

      if (v >= 0) {
        const m = SHADES[provinces[v].shade] || 1;
        rgb = [rgb[0] * m, rgb[1] * m, rgb[2] * m];
      } else {
        const g = (rgb[0] + rgb[1] + rgb[2]) / 3;
        rgb = rgb.map(x => (x * .55 + g * .45) * .62);
        kd = kd === K.TREE ? K.FOREIGN_TREE : K.FOREIGN;
      }
    }
    elev[k] = e;
    kind[k] = kd;
    col[k * 3] = rgb[0]; col[k * 3 + 1] = rgb[1]; col[k * 3 + 2] = rgb[2];
  }
  return { kind, col, elev };
}

/** 2D terrain canvas (B px per block) plus outline/fill paths per province. */
export function renderWorld(atlas, cells = classifyCells(atlas)) {
  const { map, grid, provinces } = atlas;
  const { W, H } = map;
  const { kind, col, elev } = cells;
  // Minecraft map-style relief: a block is brighter when higher than the one to its north
  const lvl = new Int16Array(W * H);
  for (let k = 0; k < W * H; k++) lvl[k] = Math.floor((elev[k] + (kind[k] === K.TREE || kind[k] === K.FOREIGN_TREE ? 25 : 0)) / 40);

  const canvas = document.createElement('canvas');
  canvas.width = W * B; canvas.height = H * B;
  const wx = canvas.getContext('2d');
  const img = wx.createImageData(W * B, H * B), px = img.data, PW = W * B;

  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const k = r * W + c, kd = kind[k];
    let sh = 1;
    if (kd !== K.WATER && r > 0 && kind[k - W] !== K.WATER) { const a = lvl[k], b = lvl[k - W]; sh = a > b ? 1.12 : a < b ? .84 : 1; }
    const cr = col[k * 3] * sh, cg = col[k * 3 + 1] * sh, cb = col[k * 3 + 2] * sh;
    for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) {
      const gx = c * B + x, gy = r * B + y;
      let n = .93 + h2(gx, gy, 3) * .14;
      if (kd === K.GRASS || kd === K.FOREIGN) { if (h2(gx, gy, 4) < .1) n *= .84; }
      else if (kd === K.TREE || kd === K.FOREIGN_TREE) { n = .78 + h2(gx >> 1, gy >> 1, 8) * .4; if (x === 0 || y === 0) n *= .9; }
      else if (kd === K.STONE) n = .82 + h2(gx >> 1, gy, 9) * .32;
      else if (kd === K.PADDY) n = (y % 4 === 0) ? .78 : 1.02 + h2(gx, gy, 3) * .06;
      else if (kd === K.WATER) { n = .97 + h2(gx, gy, 3) * .06; if (h2(gx >> 2, gy, 12) < .018) n = 1.18; }
      const o = (gy * PW + gx) * 4;
      px[o] = Math.min(255, cr * n); px[o + 1] = Math.min(255, cg * n); px[o + 2] = Math.min(255, cb * n); px[o + 3] = 255;
    }
  }

  // Dark block edges on province borders (darker on the national border)
  const darken = (gx, gy, f) => { const o = (gy * PW + gx) * 4; px[o] *= f; px[o + 1] *= f; px[o + 2] *= f; };
  const isBorder = (v, u) => v !== u && (v >= 0 || u >= 0) && v !== -1 && u !== -1;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const v = grid[r * W + c];
    if (c + 1 < W) {
      const u = grid[r * W + c + 1];
      if (isBorder(v, u)) { const f = (v >= 0 && u >= 0) ? .55 : .35; for (let y = 0; y < B; y++) { darken(c * B + B - 1, r * B + y, f); darken((c + 1) * B, r * B + y, f); } }
    }
    if (r + 1 < H) {
      const u = grid[(r + 1) * W + c];
      if (isBorder(v, u)) { const f = (v >= 0 && u >= 0) ? .55 : .35; for (let x = 0; x < B; x++) { darken(c * B + x, r * B + B - 1, f); darken(c * B + x, (r + 1) * B, f); } }
    }
  }
  wx.putImageData(img, 0, 0);

  return { canvas, ctx: wx, paths: provincePaths(map, grid, provinces.length) };
}

/** Outline (edge) and fill paths per province in world pixels. */
function provincePaths(map, grid, n) {
  const { W, H } = map;
  const paths = Array.from({ length: n }, () => ({ edge: new Path2D(), fill: new Path2D() }));
  for (let r = 0; r < H; r++) {
    let c = 0;
    while (c < W) {
      const v = grid[r * W + c];
      let e = c;
      while (e < W && grid[r * W + e] === v) e++;
      if (v >= 0) paths[v].fill.rect(c * B, r * B, (e - c) * B, B);
      c = e;
    }
    for (c = 0; c < W; c++) {
      const v = grid[r * W + c];
      if (v < 0) continue;
      const P = paths[v].edge;
      if (r === 0 || grid[(r - 1) * W + c] !== v) { P.moveTo(c * B, r * B); P.lineTo(c * B + B, r * B); }
      if (r === H - 1 || grid[(r + 1) * W + c] !== v) { P.moveTo(c * B, r * B + B); P.lineTo(c * B + B, r * B + B); }
      if (c === 0 || grid[r * W + c - 1] !== v) { P.moveTo(c * B, r * B); P.lineTo(c * B, r * B + B); }
      if (c === W - 1 || grid[r * W + c + 1] !== v) { P.moveTo(c * B + B, r * B); P.lineTo(c * B + B, r * B + B); }
    }
  }
  return paths;
}
