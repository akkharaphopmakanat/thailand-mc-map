// Renders the country terrain canvas (B px per block) and per-province outline/fill paths.
import { B, REGIONS, SHADES } from './config.js';
import { h2, vn, fbm } from './noise.js';

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Cell kinds
const WATER = 1, SAND = 2, STONE = 3, TREE = 4, PADDY = 5, FOREIGN_TREE = 6, FOREIGN = 7, GRASS = 0;

export function renderWorld({ map, grid, provinces }) {
  const { W, H } = map;
  const N = W * H;
  const lvl = new Int16Array(N), kind = new Uint8Array(N), col = new Float32Array(N * 3);

  // Water depth: distance from any land
  const depth = new Int16Array(N).fill(99);
  const q = [];
  for (let k = 0; k < N; k++) if (grid[k] !== -1) { depth[k] = 0; q.push(k); }
  for (let qi = 0; qi < q.length; qi++) {
    const k = q[qi], d = depth[k];
    if (d >= 12) continue;
    const r = (k / W) | 0, c = k % W;
    for (const [dr, dc] of DIRS) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
      const kk = rr * W + cc;
      if (depth[kk] > d + 1) { depth[kk] = d + 1; q.push(kk); }
    }
  }

  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const k = r * W + c, v = grid[k];
    let rgb, h = 0, kd = GRASS;
    if (v === -1) {
      const d = depth[k];
      rgb = d <= 1 ? [74, 122, 226] : d <= 3 ? (((r + c) & 1) ? [62, 104, 214] : [58, 96, 206])
        : d <= 6 ? [50, 82, 192] : (((r + c) & 1) && d <= 8 ? [46, 74, 180] : [40, 64, 166]);
      kd = WATER;
    } else {
      const reg = v >= 0 ? provinces[v].region : null;
      const R = reg ? REGIONS[reg] : null;
      const amp = R ? R.amp : .55;
      const f = fbm(c, r, 11);
      h = f * amp;
      let coast = false;
      for (const [dr, dc] of DIRS) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && cc >= 0 && rr < H && cc < W && grid[rr * W + cc] === -1) { coast = true; break; }
      }
      const tree = vn(c / 6, r / 6, 5) > (R ? R.forest : .5) && h2(c, r, 6) < .6;
      if (coast) { rgb = [222, 208, 160]; kd = SAND; h = 0; }
      else if (R && amp >= .85 && f > .64) { rgb = [132, 132, 134]; kd = STONE; }
      else if (tree) { const b = R ? R.base : [92, 118, 70]; rgb = [b[0] * .66, b[1] * .7, b[2] * .66]; kd = TREE; h += .12; }
      else if (reg === 'C' && vn(c / 5, r / 5, 21) > .52) { rgb = [126, 186, 78]; kd = PADDY; }
      else if (reg === 'NE' && vn(c / 4, r / 4, 31) > .7) { rgb = [136, 100, 64]; }
      else rgb = R ? R.base.slice() : [92, 118, 70];

      if (v >= 0) {
        const m = SHADES[provinces[v].shade] || 1;
        rgb = [rgb[0] * m, rgb[1] * m, rgb[2] * m];
      } else {
        const g = (rgb[0] + rgb[1] + rgb[2]) / 3;
        rgb = rgb.map(x => (x * .55 + g * .45) * .62);
        kd = kd === TREE ? FOREIGN_TREE : FOREIGN;
      }
    }
    lvl[k] = Math.floor(h * 14);
    kind[k] = kd;
    col[k * 3] = rgb[0]; col[k * 3 + 1] = rgb[1]; col[k * 3 + 2] = rgb[2];
  }

  const canvas = document.createElement('canvas');
  canvas.width = W * B; canvas.height = H * B;
  const wx = canvas.getContext('2d');
  const img = wx.createImageData(W * B, H * B), px = img.data, PW = W * B;

  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const k = r * W + c, kd = kind[k];
    // Minecraft map-style relief: brighter when higher than the block to the north
    let sh = 1;
    if (kd !== WATER && r > 0 && kind[k - W] !== WATER) { const a = lvl[k], b = lvl[k - W]; sh = a > b ? 1.12 : a < b ? .84 : 1; }
    const cr = col[k * 3] * sh, cg = col[k * 3 + 1] * sh, cb = col[k * 3 + 2] * sh;
    for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) {
      const gx = c * B + x, gy = r * B + y;
      let n = .93 + h2(gx, gy, 3) * .14;
      if (kd === GRASS || kd === FOREIGN) { if (h2(gx, gy, 4) < .1) n *= .84; }
      else if (kd === TREE || kd === FOREIGN_TREE) { n = .78 + h2(gx >> 1, gy >> 1, 8) * .4; if (x === 0 || y === 0) n *= .9; }
      else if (kd === STONE) n = .82 + h2(gx >> 1, gy, 9) * .32;
      else if (kd === PADDY) n = (y % 4 === 0) ? .78 : 1.02 + h2(gx, gy, 3) * .06;
      else if (kd === WATER) { n = .97 + h2(gx, gy, 3) * .06; if (h2(gx >> 2, gy, 12) < .018) n = 1.18; }
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

  return { canvas, paths: provincePaths(map, grid, provinces.length) };
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
