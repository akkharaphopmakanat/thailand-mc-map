// Minecraft-style rail pieces for the close-up map (2D) and the ground near the camera (3D).
// A block's piece depends on which of its four sides connect to the railway:
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
 * Track segments for a mask: straights ('ns', 'ew') and turns joining two sides
 * ('ne', 'nw', 'se', 'sw'). Three sides = straight through plus a branching turn (a junction);
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

/**
 * (along, across) coordinates of pixel (i, j) for a segment. Turns are straight 45° pieces from
 * the middle of one block edge to the middle of the other, so a staircase of turns lines up
 * into one straight diagonal track instead of a chain of loops. The gauge is narrowed on the
 * diagonal so the rails still meet the straight pieces at the block edge.
 */
const MID = { n: [8, 0], s: [8, 16], e: [16, 8], w: [0, 8] };
function railCoords(seg, i, j) {
  if (seg === 'ns') return [j, i];
  if (seg === 'ew') return [i, j];
  const [x1, y1] = MID[seg[0]], [x2, y2] = MID[seg[1]];
  const len = Math.hypot(x2 - x1, y2 - y1), dx = (x2 - x1) / len, dy = (y2 - y1) / len;
  const px = i + .5 - x1, py = j + .5 - y1;
  const along = (px * dx + py * dy) / len * 16;
  const across = 7.5 + (px * -dy + py * dx) / Math.SQRT1_2;
  // no trim at the ends: the block edge does the cutting, so pieces meet without gaps
  if (across < 0 || across > 15.9) return null;
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
      const t = ((Math.floor(ac[0]) % 4) + 4) % 4;
      // distance from the two rail centre lines (across 3.5 and 12.5); diagonal pieces use a
      // slightly wider band so 45° rails draw as solid lines, not dots
      const diag = seg.length === 2 && seg !== 'ns' && seg !== 'ew';
      const d = Math.min(Math.abs(ac[1] - 3.5), Math.abs(ac[1] - 12.5));
      const rail = diag ? .95 : .5, outline = diag ? 1.7 : 1.5;
      if (pass === 'ties') {
        const a = Math.floor(ac[1]);
        if ((t === 1 || t === 2) && a >= 1 && a <= 14) put(i, j, a === 1 || a === 14 ? TIE_D : TIE);
      } else if (d <= rail) put(i, j, IRON);
      else if (d <= outline) {
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

/* ---------------- atlas for the 3D view ---------------- */
/** All 16 rail pieces (by mask) in one texture. Returns {canvas, uv(mask) -> [u0, v0, u1, v1]}. */
export function makeAtlas() {
  const COLS = 8, n = 16, rows = n / COLS;
  const cv = document.createElement('canvas');
  cv.width = COLS * PX; cv.height = rows * PX;
  const x = cv.getContext('2d');
  const put = (t, img) => x.drawImage(img, (t % COLS) * PX, Math.floor(t / COLS) * PX);
  for (let m = 0; m < 16; m++) put(m, railTile(m));
  const eps = .5 / cv.width;
  const uv = t => {
    const c = t % COLS, r = Math.floor(t / COLS);
    return [c * PX / cv.width + eps, 1 - (r + 1) * PX / cv.height + eps, (c + 1) * PX / cv.width - eps, 1 - r * PX / cv.height - eps];
  };
  return { canvas: cv, uv };
}
