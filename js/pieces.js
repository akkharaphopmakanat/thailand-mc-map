// Minecraft-style rail and road pieces for the close-up map (2D) and the ground near the
// camera (3D). A block's piece depends on which of its four sides connect to the same network:
// mask bits N = 1, E = 2, S = 4, W = 8.
import { h2 } from './noise.js';

export const PX = 16;                               // pixels per piece
export const N = 1, E = 2, S = 4, W = 8;

/** Connection mask of block (r, c) given a predicate for "same network" at (r, c). */
export function maskAt(r, c, same) {
  return (same(r - 1, c) ? N : 0) | (same(r, c + 1) ? E : 0) | (same(r + 1, c) ? S : 0) | (same(r, c - 1) ? W : 0);
}

function canvas() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = PX;
  const x = cv.getContext('2d');
  return { cv, x, img: x.createImageData(PX, PX) };
}

/* ---------------- rails ---------------- */
const TIE = [112, 84, 52], TIE_D = [84, 62, 38], IRON = [182, 182, 190], IRON_D = [90, 90, 98];
const GRAVEL = [128, 124, 118], LEVER = [196, 40, 32], GOLD = [238, 196, 48];

/**
 * Track segments for a mask: straights ('ns', 'ew') and curves joining two sides
 * ('ne', 'nw', 'se', 'sw'). Three sides = straight through plus a branching curve (a junction);
 * four = a crossing of both straights.
 */
function railSegments(m) {
  const n = m & N, e = m & E, s = m & S, w = m & W;
  const count = !!n + !!e + !!s + !!w;
  if (count === 4) return ['ns', 'ew'];
  if (count === 3) {
    if (n && s) return ['ns', e ? 'ne' : 'nw'];      // branch off the north–south line
    return ['ew', n ? 'ne' : 'se'];                  // branch off the east–west line
  }
  if (count === 2) {
    if (n && s) return ['ns'];
    if (e && w) return ['ew'];
    return [(n ? 'n' : 's') + (e ? 'e' : 'w')];
  }
  return [(e || w) ? 'ew' : 'ns'];                  // single arm (line end) or isolated block
}

/** (along, across) coordinates of pixel (i, j) for a segment, or null if outside a curve. */
function railCoords(seg, i, j) {
  if (seg === 'ns') return [j, i];
  if (seg === 'ew') return [i, j];
  const cx = seg.includes('e') ? 16 : 0, cy = seg.includes('n') ? 0 : 16;
  const across = Math.hypot(i + .5 - cx, j + .5 - cy) - .5;
  if (across < 0 || across > 15.9) return null;
  const along = Math.atan2(Math.abs(j + .5 - cy), Math.abs(i + .5 - cx)) / (Math.PI / 2) * 16;
  return [along, across];
}

const railCache = new Map();
/** 16×16 rail piece for a connection mask (transparent background, except junction pads). */
export function railTile(mask) {
  if (railCache.has(mask)) return railCache.get(mask);
  const { cv, x, img } = canvas();
  const px = img.data;
  const put = (i, j, rgb) => { const o = (j * PX + i) * 4; px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2]; px[o + 3] = 255; };
  const segs = railSegments(mask);
  const arms = !!(mask & N) + !!(mask & E) + !!(mask & S) + !!(mask & W);
  const junction = arms >= 3;
  if (junction) {                                       // special junction block: gravel pad
    for (let j = 0; j < PX; j++) for (let i = 0; i < PX; i++) put(i, j, GRAVEL.map(v => v * (.82 + h2(i, j, 401) * .3)));
  }
  // ties first, then rails on top, so crossings and branches read cleanly
  for (const pass of ['ties', 'rails']) for (const seg of segs) {
    for (let j = 0; j < PX; j++) for (let i = 0; i < PX; i++) {
      const ac = railCoords(seg, i, j);
      if (!ac) continue;
      const a = Math.floor(ac[1]), t = Math.floor(ac[0]) % 4;
      if (pass === 'ties') {
        if ((t === 1 || t === 2) && a >= 1 && a <= 14) put(i, j, a === 1 || a === 14 ? TIE_D : TIE);
      } else if (a === 3 || a === 12) put(i, j, IRON);
      else if (a === 2 || a === 4 || a === 11 || a === 13) {
        if (!(junction && (t === 1 || t === 2))) put(i, j, IRON_D);
      }
    }
  }
  if (arms === 1) {                                     // buffer stop at the open end
    const open = { [N]: 'S', [S]: 'N', [E]: 'W', [W]: 'E' }[mask];
    for (let k = 2; k <= 13; k++) {
      if (open === 'S') { put(k, 14, TIE_D); put(k, 15, LEVER); }
      if (open === 'N') { put(k, 1, TIE_D); put(k, 0, LEVER); }
      if (open === 'E') { put(14, k, TIE_D); put(15, k, LEVER); }
      if (open === 'W') { put(1, k, TIE_D); put(0, k, LEVER); }
    }
  }
  if (junction) {                                       // switch lever: stone base, gold pivot, red handle
    const lx = mask & W ? 13 : 0, ly = mask & N ? 13 : 0;
    put(lx, ly, [70, 70, 74]); put(lx + 1, ly, [70, 70, 74]); put(lx, ly + 1, [70, 70, 74]); put(lx + 1, ly + 1, GOLD);
    put(lx + (lx ? -1 : 2), ly + (ly ? 1 : 0), LEVER);
  }
  x.putImageData(img, 0, 0);
  railCache.set(mask, cv);
  return cv;
}

/* ---------------- roads ---------------- */
/** Road class for a block's road code: 3 large (trunk/motorway), 2 medium (primary/secondary), 1 local. */
export const roadClass = code => code === 4 ? 3 : code === 2 || code === 3 ? 2 : code === 1 ? 1 : 0;

const ROAD_STYLE = {
  3: { rgb: [132, 132, 136], edge: [88, 88, 92], w: 12, line: true, noise: .12 },   // large: stone, centre line
  2: { rgb: [122, 122, 122], edge: [84, 84, 84], w: 10, line: false, noise: .35 },  // medium: cobblestone
  1: { rgb: [150, 122, 70], edge: [112, 86, 50], w: 8, line: false, noise: .22 },   // local: dirt path
};

const roadCache = new Map();
/** 16×16 road piece: a band from the centre to each connected side (transparent elsewhere). */
export function roadTile(cls, mask) {
  const key = cls * 16 + mask;
  if (roadCache.has(key)) return roadCache.get(key);
  const { cv, x, img } = canvas();
  const px = img.data, st = ROAD_STYLE[cls];
  const lo = (PX - st.w) >> 1, hi = lo + st.w - 1;          // band across the centre
  const m = mask || N | S;                                   // isolated block: show a short straight
  const inBand = (i, j) => {
    const core = i >= lo && i <= hi && j >= lo && j <= hi;
    return core || (m & N && j < lo && i >= lo && i <= hi) || (m & S && j > hi && i >= lo && i <= hi) ||
      (m & W && i < lo && j >= lo && j <= hi) || (m & E && i > hi && j >= lo && j <= hi);
  };
  for (let j = 0; j < PX; j++) for (let i = 0; i < PX; i++) {
    if (!inBand(i, j)) continue;
    const edge = !inBand(i - 1, j) && i > 0 || !inBand(i + 1, j) && i < PX - 1 || !inBand(i, j - 1) && j > 0 || !inBand(i, j + 1) && j < PX - 1;
    const r = h2(cls === 2 ? i >> 1 : i, cls === 2 ? j >> 1 : j, 410 + cls);
    let rgb = edge ? st.edge : st.rgb.map(v => v * (1 - st.noise / 2 + r * st.noise));
    if (st.line) {                                          // dashed yellow centre line along each arm
      const onV = (i === 7 || i === 8) && ((m & N && j < 8) || (m & S && j >= 8)) && j % 4 < 2;
      const onH = (j === 7 || j === 8) && ((m & W && i < 8) || (m & E && i >= 8)) && i % 4 < 2;
      if (onV || onH) rgb = [236, 196, 52];
    }
    const o = (j * PX + i) * 4;
    px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2]; px[o + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  roadCache.set(key, cv);
  return cv;
}

/* ---------------- atlas for the 3D view ---------------- */
/**
 * All pieces in one texture: rail masks 0–15 in tiles 0–15, road class c and mask m in tile
 * 16 + (c - 1) * 16 + m. Returns {canvas, uv(tile) -> [u0, v0, u1, v1]}.
 */
export function makeAtlas() {
  const COLS = 8, n = 64, rows = n / COLS;
  const cv = document.createElement('canvas');
  cv.width = COLS * PX; cv.height = rows * PX;
  const x = cv.getContext('2d');
  const put = (t, img) => x.drawImage(img, (t % COLS) * PX, Math.floor(t / COLS) * PX);
  for (let m = 0; m < 16; m++) put(m, railTile(m));
  for (let c = 1; c <= 3; c++) for (let m = 0; m < 16; m++) put(16 + (c - 1) * 16 + m, roadTile(c, m));
  const eps = .5 / cv.width;
  const uv = t => {
    const c = t % COLS, r = Math.floor(t / COLS);
    return [c * PX / cv.width + eps, 1 - (r + 1) * PX / cv.height + eps, (c + 1) * PX / cv.width - eps, 1 - r * PX / cv.height - eps];
  };
  return { canvas: cv, uv, railTile: m => m, roadTile: (c, m) => 16 + (c - 1) * 16 + m };
}
