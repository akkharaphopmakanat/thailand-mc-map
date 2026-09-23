// Minecraft-style buildings for settlement blocks: a runtime pixel-texture atlas, procedural
// voxel prefabs (houses, farms, wells, Thai temples, city towers), a mesher for the 3D view
// and top-down tiles for the 2D map. Each map block holds a 16×16 voxel plot.
import { h2 } from './noise.js';

export const PLOT = 16;                           // voxels across one map block

/* ---------------- texture atlas ---------------- */
const TILE = 16, COLS = 8;
export const RAIL_KINDS = ['ns', 'ew', 'ne', 'nw', 'se', 'sw'];
export const RAIL_TILE0 = 23;                      // atlas tiles 23..28 hold the rail pieces
// material id -> [atlas tile for sides, tile for top/bottom]
const M = {
  planks: 1, log: 2, cobble: 3, bricks: 4, glass: 5, door: 6, doorTop: 7, roof: 8, darkRoof: 9,
  plaster: 10, hay: 11, farmland: 12, path: 13, gold: 14, orangeRoof: 15, leaves: 16, stone: 17, water: 18, road: 19,
};
const TILES = {
  [M.planks]: [0, 0], [M.log]: [1, 2], [M.cobble]: [3, 3], [M.bricks]: [4, 4], [M.glass]: [5, 5],
  [M.door]: [6, 0], [M.doorTop]: [7, 0], [M.roof]: [8, 8], [M.darkRoof]: [9, 9], [M.plaster]: [10, 10],
  [M.hay]: [11, 12], [M.farmland]: [13, 14], [M.path]: [15, 16], [M.gold]: [17, 17], [M.orangeRoof]: [18, 18],
  [M.leaves]: [19, 19], [M.stone]: [20, 20], [M.water]: [21, 21], [M.road]: [22, 22],
};
/** Average colour per material, for the 2D top-down tiles. */
const TOP_RGB = {
  [M.planks]: [162, 130, 78], [M.log]: [152, 118, 70], [M.cobble]: [122, 122, 122], [M.bricks]: [150, 150, 152],
  [M.glass]: [190, 222, 236], [M.roof]: [168, 64, 48], [M.darkRoof]: [74, 52, 34], [M.plaster]: [222, 214, 196],
  [M.hay]: [196, 164, 40], [M.farmland]: [104, 150, 48], [M.path]: [150, 122, 70], [M.gold]: [238, 196, 48],
  [M.orangeRoof]: [226, 110, 36], [M.leaves]: [58, 120, 40], [M.stone]: [128, 128, 130], [M.water]: [58, 104, 214],
  [M.road]: [96, 96, 100], [M.door]: [120, 88, 50], [M.doorTop]: [120, 88, 50],
};

/** Paint the 16×16 pixel textures into one canvas. Returns {canvas, uv(tile) -> [u0, v0, u1, v1]}. */
export function makeAtlas() {
  const n = RAIL_TILE0 + RAIL_KINDS.length, rows = Math.ceil(n / COLS);
  const cv = document.createElement('canvas');
  cv.width = COLS * TILE; cv.height = rows * TILE;
  const x = cv.getContext('2d');
  const img = x.createImageData(cv.width, cv.height), px = img.data;
  const set = (t, i, j, rgb, f = 1) => {
    const X = (t % COLS) * TILE + i, Y = Math.floor(t / COLS) * TILE + j, o = (Y * cv.width + X) * 4;
    px[o] = Math.min(255, rgb[0] * f); px[o + 1] = Math.min(255, rgb[1] * f); px[o + 2] = Math.min(255, rgb[2] * f); px[o + 3] = 255;
  };
  const n1 = (t, i, j) => h2(i + t * 31, j, 90 + t);
  const paint = (t, fn) => { for (let j = 0; j < TILE; j++) for (let i = 0; i < TILE; i++) fn(i, j, n1(t, i, j)); };
  paint(0, (i, j, r) => set(0, i, j, [162, 130, 78], (j % 4 === 3 ? .72 : .9 + r * .18) * ((i + (j >> 2) * 5) % 16 === 0 ? .8 : 1)));   // oak planks
  paint(1, (i, j, r) => set(1, i, j, [104, 80, 50], (i % 3 === 0 ? .78 : .92 + r * .16)));                                       // log bark
  paint(2, (i, j, r) => { const d = Math.max(Math.abs(i - 7.5), Math.abs(j - 7.5)); set(2, i, j, d > 6 ? [104, 80, 50] : [176, 140, 86], d % 3 < 1 ? .85 : 1); }); // log top rings
  paint(3, (i, j, r) => set(3, i, j, [124, 124, 124], h2(i >> 2, j >> 2, 93) < .3 ? .65 : .82 + r * .3));                         // cobblestone
  paint(4, (i, j, r) => set(4, i, j, [150, 150, 152], (j % 8 === 7 || (i + (j >> 3) * 8) % 16 === 15) ? .6 : .9 + r * .14));     // stone bricks
  paint(5, (i, j, r) => set(5, i, j, (i === 0 || j === 0 || i === 15 || j === 15) ? [220, 236, 240] : [150, 200, 222], (i === j + 3 || i === j + 4) ? 1.25 : 1)); // glass
  paint(6, (i, j, r) => set(6, i, j, [120, 88, 50], (i === 0 || i === 15 || j === 15) ? .6 : (i === 12 && j === 8) ? .3 : .9 + r * .15));   // door bottom
  paint(7, (i, j, r) => set(7, i, j, (j > 3 && j < 11 && i > 3 && i < 12) ? [150, 200, 222] : [120, 88, 50], (i === 0 || i === 15 || j === 0) ? .6 : .92 + r * .12)); // door top
  paint(8, (i, j, r) => set(8, i, j, [168, 64, 48], (j % 4 === 0) ? .7 : .9 + r * .16));                                        // red clay roof
  paint(9, (i, j, r) => set(9, i, j, [74, 52, 34], (j % 4 === 0) ? .7 : .9 + r * .18));                                         // dark oak roof
  paint(10, (i, j, r) => set(10, i, j, [222, 214, 196], .93 + r * .1));                                                          // white plaster
  paint(11, (i, j, r) => set(11, i, j, [196, 164, 40], (j % 3 === 0) ? .78 : .92 + r * .16));                                     // hay side
  paint(12, (i, j, r) => set(12, i, j, [206, 176, 52], ((i + j) % 4 === 0) ? .8 : .95 + r * .1));                                 // hay top
  paint(13, (i, j, r) => set(13, i, j, j < 5 ? [90, 150, 48] : [110, 76, 46], .88 + r * .2));                                    // farmland side
  paint(14, (i, j, r) => set(14, i, j, (i % 4 === 1 || i % 4 === 2) ? [96, 160, 44] : [92, 62, 38], .85 + r * .25));               // wheat rows
  paint(15, (i, j, r) => set(15, i, j, j < 2 ? [150, 122, 70] : [120, 86, 58], .88 + r * .2));                                   // path side
  paint(16, (i, j, r) => set(16, i, j, [150, 122, 70], .86 + r * .24));                                                          // dirt path
  paint(17, (i, j, r) => set(17, i, j, [238, 196, 48], (i + j) % 5 === 0 ? 1.15 : .9 + r * .12));                                 // gold
  paint(18, (i, j, r) => set(18, i, j, [226, 110, 36], (j % 4 === 0) ? .72 : .92 + r * .14));                                     // orange temple roof
  paint(19, (i, j, r) => set(19, i, j, [58, 120, 40], r < .25 ? .6 : .85 + r * .3));                                            // leaves
  paint(20, (i, j, r) => set(20, i, j, [128, 128, 130], .85 + r * .25));                                                         // stone
  paint(21, (i, j, r) => set(21, i, j, [58, 104, 214], .9 + r * .15));                                                           // water
  paint(22, (i, j, r) => set(22, i, j, [96, 96, 100], (i === 7 && j % 6 < 3) ? 1.9 : .9 + r * .12));                              // asphalt road
  x.putImageData(img, 0, 0);
  RAIL_KINDS.forEach((k, i) => { const t = RAIL_TILE0 + i; x.drawImage(railTile(k), (t % COLS) * TILE, Math.floor(t / COLS) * TILE); });
  const eps = .5 / cv.width;
  const uv = t => {
    const c = t % COLS, r = Math.floor(t / COLS);
    return [c * TILE / cv.width + eps, 1 - (r + 1) * TILE / cv.height + eps, (c + 1) * TILE / cv.width - eps, 1 - r * TILE / cv.height - eps];
  };
  return { canvas: cv, uv, tileSize: [TILE / cv.width - 2 * eps, TILE / cv.height - 2 * eps] };
}

/* ---------------- voxel plots ---------------- */
/** A sparse voxel plot: key (x, y, z) -> material. */
class Plot {
  constructor() { this.v = new Map(); }
  set(x, y, z, m) {
    if (x < 0 || z < 0 || x >= PLOT || z >= PLOT || y < 0) return;
    const k = x | (z << 5) | (y << 10);
    if (m) this.v.set(k, m); else this.v.delete(k);
  }
  get(x, y, z) { return this.v.get(x | (z << 5) | (y << 10)) || 0; }
  box(x0, y0, z0, x1, y1, z1, m) { for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.set(x, y, z, m); }
}

/** Gable-roofed house: cobblestone footing, log corners, plank or plaster walls, windows, door. */
function house(p, x0, z0, w, d, rnd, alongX = true) {
  const x1 = x0 + w - 1, z1 = z0 + d - 1, H = 3;
  const wall = rnd < .5 ? M.planks : M.plaster, roof = rnd < .3 ? M.darkRoof : M.roof;
  p.box(x0, 0, z0, x1, 0, z1, M.cobble);
  p.box(x0, 1, z0, x1, H, z1, wall);                     // solid inside: no hidden interior faces
  for (let y = 1; y <= H; y++) for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) p.set(x, y, z, M.log);
  // windows on the long sides, door in the middle of the front
  const midX = (x0 + x1) >> 1, midZ = (z0 + z1) >> 1;
  if (alongX) { p.set(x0 + 1, 2, z0, M.glass); p.set(x1 - 1, 2, z0, M.glass); p.set(x0 + 1, 2, z1, M.glass); p.set(x1 - 1, 2, z1, M.glass); p.set(midX, 1, z1, M.door); p.set(midX, 2, z1, M.doorTop); }
  else { p.set(x0, 2, z0 + 1, M.glass); p.set(x0, 2, z1 - 1, M.glass); p.set(x1, 2, z0 + 1, M.glass); p.set(x1, 2, z1 - 1, M.glass); p.set(x1, 1, midZ, M.door); p.set(x1, 2, midZ, M.doorTop); }
  // stepped gable roof with a one-voxel overhang
  const span = alongX ? d : w;
  for (let s = 0; s <= span >> 1; s++) {
    const y = H + 1 + s;
    if (alongX) { p.box(x0 - 1, y, z0 - 1 + s, x1 + 1, y, z0 - 1 + s, roof); p.box(x0 - 1, y, z1 + 1 - s, x1 + 1, y, z1 + 1 - s, roof); }
    else { p.box(x0 - 1 + s, y, z0 - 1, x0 - 1 + s, y, z1 + 1, roof); p.box(x1 + 1 - s, y, z0 - 1, x1 + 1 - s, y, z1 + 1, roof); }
  }
}

function farm(p, x0, z0, w, d) {
  p.box(x0, 0, z0, x0 + w - 1, 0, z0 + d - 1, M.farmland);
  for (let x = x0; x < x0 + w; x++) p.set(x, 0, z0 + (d >> 1), M.water);
}

function tree(p, x, z, rnd) {
  const h = 3 + Math.floor(rnd * 2);
  p.box(x - 2, h, z - 2, x + 2, h + 1, z + 2, M.leaves);
  p.box(x - 1, h + 2, z - 1, x + 1, h + 2, z + 1, M.leaves);
  for (let y = 1; y <= h; y++) p.set(x, y, z, M.log);
}

function well(p, x, z) {
  p.box(x, 0, z, x + 2, 1, z + 2, M.cobble);
  p.set(x + 1, 1, z + 1, M.water);
  p.set(x, 2, z, M.log); p.set(x + 2, 2, z, M.log); p.set(x, 2, z + 2, M.log); p.set(x + 2, 2, z + 2, M.log);
  p.box(x, 3, z, x + 2, 3, z + 2, M.darkRoof);
}

/** Thai temple (wat): white plaster hall, tiered orange roof, gold spire. */
function temple(p, x0, z0) {
  const w = 7, d = 9, x1 = x0 + w - 1, z1 = z0 + d - 1;
  p.box(x0 - 1, 0, z0 - 1, x1 + 1, 0, z1 + 1, M.stone);
  p.box(x0, 1, z0, x1, 3, z1, M.plaster);
  p.set((x0 + x1) >> 1, 1, z1, M.door); p.set((x0 + x1) >> 1, 2, z1, M.doorTop);
  for (let s = 0; s < 3; s++) p.box(x0 - 1 + s, 4 + s, z0 - 1 + s, x1 + 1 - s, 4 + s, z1 + 1 - s, M.orangeRoof);
  for (let y = 7; y <= 10; y++) p.set((x0 + x1) >> 1, y, (z0 + z1) >> 1, M.gold);
  p.set(x0 - 1, 1, z0 - 1, M.gold); p.set(x1 + 1, 1, z0 - 1, M.gold);
}

/** City tower: stone bricks with window bands, flat roof. */
function tower(p, x0, z0, w, d, h) {
  const x1 = x0 + w - 1, z1 = z0 + d - 1;
  for (let y = 0; y <= h; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    const corner = (x === x0 || x === x1) && (z === z0 || z === z1);
    p.set(x, y, z, y === h ? M.stone : !corner && y % 3 === 2 ? M.glass : M.bricks);
  }
}

/** Voxel plot for a settlement block (code 1 village, 2 town, 3 city), varied by block position. */
export function plotFor(code, c, r) {
  const key = `${code}:${Math.floor(h2(c, r, 301) * 6)}`;
  let p = cache.get(key);
  if (p) return p;
  p = new Plot();
  const v = +key.split(':')[1], rnd = (s) => h2(v, s, 311);
  if (code === 1) {                                       // village: house, farm, path, tree
    p.box(0, 0, 7, 15, 0, 8, M.path);
    house(p, 2 + (v % 2) * 6, 1, 5, 5, rnd(1), true);
    farm(p, 1 + ((v + 1) % 2) * 7, 10, 7, 5);
    tree(p, v % 2 ? 3 : 12, v % 3 ? 3 : 12, rnd(2));
  } else if (code === 2) {                                // town: houses around a crossroads, well, sometimes a wat
    p.box(0, 0, 7, 15, 0, 8, M.path); p.box(7, 0, 0, 8, 0, 15, M.path);
    if (v % 3 === 0) { temple(p, 0, 0); } else { house(p, 1, 1, 5, 5, rnd(3), true); }
    house(p, 10, 1, 5, 5, rnd(4), false);
    house(p, 1, 10, 5, 5, rnd(5), false);
    well(p, 11, 11);
  } else {                                                // city: towers on a street grid
    p.box(0, 0, 0, 15, 0, 15, M.road);
    const hs = [6 + Math.floor(rnd(6) * 12), 5 + Math.floor(rnd(7) * 9), 4 + Math.floor(rnd(8) * 8), 7 + Math.floor(rnd(9) * 14)];
    tower(p, 1, 1, 6, 6, hs[0]); tower(p, 9, 1, 6, 6, hs[1]); tower(p, 1, 9, 6, 6, hs[2]);
    if (v % 4 === 0) temple(p, 9, 7); else tower(p, 9, 9, 6, 6, hs[3]);
  }
  cache.set(key, p);
  return p;
}
const cache = new Map();

/**
 * Mesh a plot once into a template with greedy meshing: for each face direction, exposed faces of
 * the same material in a slice are merged into rectangles. Each vertex carries a repeating local
 * uv (in voxels) and its atlas tile origin, so the block shader can tile the 16×16 texture across
 * the rectangle. Positions are local (x, z in 0..1 across the block, y in voxels × vy).
 * Returns {pos, uv, tile, shade, n}; placing a building is then just an offset copy.
 */
const templates = new Map();
export function plotTemplate(code, c, r, vy, atlas) {
  const key = `${code}:${Math.floor(h2(c, r, 301) * 6)}:${vy}`;
  if (templates.has(key)) return templates.get(key);
  const p = plotFor(code, c, r);
  const s = 1 / PLOT;
  let top = 0;
  for (const k of p.v.keys()) top = Math.max(top, k >> 10);
  const YN = top + 1;
  const open = (x, y, z) => { const n = p.get(x, y, z); return !n || n === M.glass || n === M.water || n === M.leaves; };
  const pos = [], uv = [], tile = [], shade = [];
  // axis: 0 = x, 1 = y, 2 = z; dir ±1; (u, v) are the other two axes
  const DIRS = [[1, 1, 1.0], [1, -1, .5], [0, 1, .62], [0, -1, .62], [2, 1, .8], [2, -1, .8]];
  const size = [PLOT, YN, PLOT];
  for (const [axis, dir, sh] of DIRS) {
    const ua = axis === 1 ? 0 : axis === 0 ? 2 : 0;       // horizontal axis in the face
    const va = axis === 1 ? 2 : 1;                         // vertical axis in the face (y for walls, z for tops)
    const U = size[ua], V = size[va];
    for (let d = 0; d < size[axis]; d++) {
      const mask = new Int32Array(U * V);
      for (let v = 0; v < V; v++) for (let u = 0; u < U; u++) {
        const q = [0, 0, 0]; q[axis] = d; q[ua] = u; q[va] = v;
        const m = p.get(q[0], q[1], q[2]);
        if (!m) continue;
        const nb = [...q]; nb[axis] += dir;
        if (axis === 1 && dir < 0 && d === 0) continue;       // ground-facing bottom
        if (open(nb[0], nb[1], nb[2])) mask[v * U + u] = m;
      }
      for (let v = 0; v < V; v++) for (let u = 0; u < U;) {
        const m = mask[v * U + u];
        if (!m) { u++; continue; }
        let w = 1;
        while (u + w < U && mask[v * U + u + w] === m) w++;
        let h = 1;
        grow: while (v + h < V) {
          for (let i = 0; i < w; i++) if (mask[(v + h) * U + u + i] !== m) break grow;
          h++;
        }
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) mask[(v + j) * U + u + i] = 0;
        // corners in voxel coordinates
        const plane = dir > 0 ? d + 1 : d;
        const corner = (du, dv) => { const q = [0, 0, 0]; q[axis] = plane; q[ua] = u + du; q[va] = v + dv; return [q[0] * s, q[1] * vy, q[2] * s]; };
        const a0 = corner(0, 0), a1 = corner(0, h), a2 = corner(w, h), a3 = corner(w, 0);
        pos.push(...a0, ...a1, ...a2, ...a3);
        // walls: v runs up; flip u on the far-facing sides so textures are not mirrored
        uv.push(0, 0, 0, h, w, h, w, 0);
        const t = TILES[m][axis === 1 ? 1 : 0];
        const [u0, v0] = atlas.uv(t);
        for (let i = 0; i < 4; i++) { tile.push(u0, v0); shade.push(sh); }
        u += w;
      }
    }
  }
  const t = { pos: new Float32Array(pos), uv: new Float32Array(uv), tile: new Float32Array(tile), shade: new Float32Array(shade), n: pos.length / 12 };
  templates.set(key, t);
  return t;
}

/** Shader for block textures that repeat across greedy-meshed rectangles (with fog). */
export function blockMaterial(THREE, texture, tileSize) {
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { atlas: { value: null }, tileSize: { value: null } }]);
  uniforms.atlas.value = texture;
  uniforms.tileSize.value = new THREE.Vector2(tileSize[0], tileSize[1]);
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      attribute vec2 tile; attribute float shade;
      varying vec2 vUv; varying vec2 vTile; varying float vShade;
      #include <fog_pars_vertex>
      void main() {
        vUv = uv; vTile = tile; vShade = shade;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform sampler2D atlas; uniform vec2 tileSize;
      varying vec2 vUv; varying vec2 vTile; varying float vShade;
      #include <fog_pars_fragment>
      void main() {
        vec4 c = texture2D(atlas, vTile + fract(vUv) * tileSize);
        if (c.a < .5) discard;
        gl_FragColor = vec4(c.rgb * vShade, 1.0);
        #include <fog_fragment>
      }`,
    fog: true,
    side: THREE.DoubleSide,
  });
}

/** 16×16 top-down tile of a plot for the 2D map (colour of the highest voxel per column). */
const topCache = new Map();
export function topTile(code, c, r) {
  const key = `${code}:${Math.floor(h2(c, r, 301) * 6)}`;
  if (topCache.has(key)) return topCache.get(key);
  const p = plotFor(code, c, r);
  const cv = document.createElement('canvas');
  cv.width = cv.height = PLOT;
  const x = cv.getContext('2d');
  const img = x.createImageData(PLOT, PLOT);
  const top = new Map();
  for (const [k, m] of p.v) {
    const col = k & 1023, y = k >> 10;
    if (!top.has(col) || top.get(col)[0] < y) top.set(col, [y, m]);
  }
  for (const [col, [y, m]] of top) {
    const X = col & 31, Z = col >> 5, o = (Z * PLOT + X) * 4, rgb = TOP_RGB[m] || [200, 0, 200];
    const f = (.9 + h2(X, Z, 320) * .15) * (1 + Math.min(y, 12) * .015);
    img.data[o] = Math.min(255, rgb[0] * f); img.data[o + 1] = Math.min(255, rgb[1] * f); img.data[o + 2] = Math.min(255, rgb[2] * f); img.data[o + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  topCache.set(key, cv);
  return cv;
}

/* ---------------- Minecraft rail pieces ---------------- */
/**
 * 16×16 rail piece with a transparent background: two iron rails on oak ties.
 * kind: 'ns' | 'ew' straight, or a curve joining two sides: 'ne' | 'nw' | 'se' | 'sw'.
 */
const railCache = new Map();
export function railTile(kind) {
  if (railCache.has(kind)) return railCache.get(kind);
  const cv = document.createElement('canvas');
  cv.width = cv.height = PLOT;
  const x = cv.getContext('2d');
  const img = x.createImageData(PLOT, PLOT), px = img.data;
  const put = (i, j, rgb) => { const o = (j * PLOT + i) * 4; px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2]; px[o + 3] = 255; };
  const TIE = [112, 84, 52], TIE_D = [84, 62, 38], IRON = [178, 178, 186], IRON_D = [92, 92, 100];
  for (let j = 0; j < PLOT; j++) for (let i = 0; i < PLOT; i++) {
    // "along" runs with the track, "across" from one rail to the other (0..15)
    let along, across;
    if (kind === 'ns') { along = j; across = i; }
    else if (kind === 'ew') { along = i; across = j; }
    else {
      // curve around the corner shared by the two joined sides
      const cx = kind.includes('e') ? 16 : 0, cy = kind.includes('n') ? 0 : 16;
      const d = Math.hypot(i + .5 - cx, j + .5 - cy);
      across = d - .5;
      along = Math.atan2(Math.abs(j + .5 - cy), Math.abs(i + .5 - cx)) / (Math.PI / 2) * 16;
      if (across < 0 || across > 15.9) continue;
    }
    const a = Math.floor(across), t = Math.floor(along) % 4;
    if (a === 3 || a === 12) put(i, j, IRON);
    else if (a === 2 || a === 4 || a === 11 || a === 13) put(i, j, (t === 1 || t === 2) ? TIE_D : IRON_D);
    else if ((t === 1 || t === 2) && a >= 1 && a <= 14) put(i, j, a === 1 || a === 14 ? TIE_D : TIE);
  }
  x.putImageData(img, 0, 0);
  railCache.set(kind, cv);
  return cv;
}

/** Which rail piece a railway block needs, from its railway neighbours (N, S, E, W). */
export function railKind(n, s, e, w) {
  if ((n || s) && !(e || w)) return 'ns';
  if ((e || w) && !(n || s)) return 'ew';
  if (n && e) return 'ne';
  if (n && w) return 'nw';
  if (s && e) return 'se';
  if (s && w) return 'sw';
  return 'ns';
}
