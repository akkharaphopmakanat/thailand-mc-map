// Minecraft-style rail pieces for the close-up map (2D) and the ground near the camera (3D).
// A block's piece depends on which of its four sides connect to the railway:
// mask bits N = 1, E = 2, S = 4, W = 8.
import { h2 } from './noise.js';
import { TEXTURES } from './textures.js';
import { KIND } from './world.js';

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

/* ---------------- block textures (Minetest Game, CC BY-SA 3.0) ---------------- */
// Tiles in the block atlas. Side textures that are overlays in Minetest are composited on dirt.
export const TEX = ['grass', 'grass_side', 'dry_grass', 'dry_grass_side', 'dirt', 'dry_dirt', 'stone', 'sand',
  'gravel', 'water', 'river_water', 'leaves', 'jungleleaves', 'tree', 'wood', 'snow', 'rainforest_litter',
  'rainforest_litter_side', 'cobble', 'stone_brick', 'desert_sand'];
const OVER_DIRT = new Set(['grass_side', 'dry_grass_side', 'rainforest_litter_side']);
const OPAQUE_ON = { leaves: '#1f4a14', jungleleaves: '#173a10', water: '#2a52c0', river_water: '#2a62c8' };

const loadImage = src => new Promise((resolve, reject) => {
  const im = new Image();
  im.onload = () => resolve(im);
  im.onerror = reject;
  im.src = src;
});

/**
 * Build the block texture atlas (8 columns of 16×16). Returns
 * {canvas, tile(name) -> index, origin(index) -> [u, v] of the tile's bottom-left, size: [du, dv]}.
 */
export async function makeBlockAtlas() {
  const imgs = Object.fromEntries(await Promise.all(TEX.map(async n => [n, await loadImage(TEXTURES[n])])));
  const COLS = 8, rows = Math.ceil(TEX.length / COLS);
  const cv = document.createElement('canvas');
  cv.width = COLS * PX; cv.height = rows * PX;
  const x = cv.getContext('2d');
  x.imageSmoothingEnabled = false;
  TEX.forEach((n, i) => {
    const dx = (i % COLS) * PX, dy = Math.floor(i / COLS) * PX;
    if (OVER_DIRT.has(n)) x.drawImage(imgs.dirt, dx, dy);
    if (OPAQUE_ON[n]) { x.fillStyle = OPAQUE_ON[n]; x.fillRect(dx, dy, PX, PX); }
    x.drawImage(imgs[n], dx, dy);
  });
  const index = Object.fromEntries(TEX.map((n, i) => [n, i]));
  const du = PX / cv.width, dv = PX / cv.height;
  return {
    canvas: cv,
    tile: n => index[n],
    origin: i => [(i % COLS) * du, 1 - (Math.floor(i / COLS) + 1) * dv],
    size: [du, dv],
  };
}

/** Shader for block textures repeating across merged faces, tinted per vertex, with fog. */
export function blockMaterial(THREE, texture, size) {
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { atlas: { value: null }, tileSize: { value: null } }]);
  uniforms.atlas.value = texture;
  uniforms.tileSize.value = new THREE.Vector2(size[0], size[1]);
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      attribute vec2 tile; attribute vec3 tint;
      varying vec2 vUv; varying vec2 vTile; varying vec3 vTint;
      #include <fog_pars_vertex>
      void main() {
        vUv = uv; vTile = tile; vTint = tint;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform sampler2D atlas; uniform vec2 tileSize;
      varying vec2 vUv; varying vec2 vTile; varying vec3 vTint;
      #include <fog_pars_fragment>
      void main() {
        vec2 f = clamp(fract(vUv), .001, .999);
        vec4 c = texture2D(atlas, vTile + f * tileSize);
        gl_FragColor = vec4(c.rgb * vTint, 1.0);
        #include <fog_fragment>
      }`,
    fog: true,
    side: THREE.DoubleSide,
  });
}

/**
 * Texture name for the top of block k: water blocks show their seabed, then rivers, rails,
 * roads (per layer), stone, sand, leaves (jungle leaves in the south and east), and grass
 * (dry grass in Isan). hb = block heights (3D) or null (2D).
 */
export function blockTexture(k, atlas, cells, layers, hb = null) {
  const kd = cells.kind[k], w = atlas.streams?.[k], rd = atlas.roads?.[k];
  if (kd === KIND.WATER) return (hb ? hb[k] > -3 : cells.elev[k] > -25) ? 'sand' : 'gravel';
  if (w >= 2 ? layers.rivers : w === 1 && layers.streams) return 'river_water';
  if (rd === 5 && layers.rails) return 'gravel';
  if (rd === 4 && layers.mainRoads) return 'stone';
  if ((rd === 2 || rd === 3) && layers.mediumRoads) return 'dry_dirt';
  if (kd === KIND.STONE) return 'stone';
  if (kd === KIND.SAND) return 'sand';
  const v = atlas.grid[k], reg = v >= 0 ? atlas.provinces[v].region : null;
  if (kd === KIND.TREE || kd === KIND.FOREIGN_TREE) return reg === 'S' || reg === 'E' ? 'jungleleaves' : 'leaves';
  return reg === 'NE' ? 'dry_grass' : 'grass';
}
