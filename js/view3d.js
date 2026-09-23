// 3D voxel view: every map block becomes a column at its real elevation.
// The map is split into chunks; chunks near the camera are drawn at full detail and
// farther ones with 2×, 4× or 8× bigger blocks (like a render distance), built on demand.
// three.js is loaded from cdnjs the first time the 3D mode is opened.
import { B, SHADES } from './config.js';
import { KIND } from './world.js';
import { makeAtlas, maskAt, makeBlockAtlas, blockMaterial, blockTexture } from './pieces.js';
import { h2 } from './noise.js';
import { itemSprite } from './sprites.js';

const THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
const SKY = 0x8fb8ff;
const MIN_Y = -16;                                 // bottom of the world slab
const SHADE = { top: 1, ns: .8, ew: .62 };         // Minecraft-style face brightness
const DIRT = [134, 96, 67], LOG = [102, 76, 44];
const CHUNK = 64;                                  // full-detail blocks per chunk side
const LODS = [1, 2, 4, 8];                         // block size multiplier per level of detail
const BUILD_BUDGET_MS = 10;                        // chunk building time per frame
const MAX_DPR = 1.5;                               // cap render resolution for a steady frame rate
const DETAIL_RADIUS = 40;                          // blocks around the look-at point that get rail pieces
const DETAIL_CAMERA = 160;                         // …only when the camera is at most this far away
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

let threePromise = null;
function loadThree() {
  if (window.THREE) return Promise.resolve(window.THREE);
  threePromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = THREE_URL;
    s.onload = () => resolve(window.THREE);
    s.onerror = () => { threePromise = null; reject(new Error('Could not load three.js from cdnjs')); };
    document.head.appendChild(s);
  });
  return threePromise;
}

/** @returns {Promise<View3D>} */
export async function createView3D(opts) {
  const [THREE, blocks] = await Promise.all([loadThree(), makeBlockAtlas().catch(() => null)]);
  return new View3D(THREE, { ...opts, blocks });
}

const TEXTURED_LOD = 2;                            // chunks at this level of detail or finer use block textures

class View3D {
  /**
   * @param {object} THREE
   * @param {object} o  {canvas, wrap, atlas, cells, world (2D terrain, used as top texture),
   *                    backdrops ([{data, canvas}] world and ASEAN, canvases used for colours), onHover, onClick}
   */
  constructor(THREE, { canvas, wrap, atlas, cells, world, backdrops = [], blocks, onHover, onClick }) {
    Object.assign(this, { T: THREE, canvas, wrap, atlas, cells, world, backdrops, blocks, onHover, onClick });
    const { W, H } = atlas.map;
    this.W = W; this.H = H;
    this.SC = .04 / atlas.map.S;                     // blocks per 0.04° (camera and icon sizes scale with it)
    this.metresPerBlock = 40;
    this.selected = -1; this.hover = -1; this.layer = null; this.dFocus = -1;
    this.active = false; this.tween = null;
    this.layers = { mainRoads: true, mediumRoads: true, rails: true, rivers: true, streams: false };
    this.home = { x: 0, z: 40 * this.SC, yaw: 0, pitch: .9, dist: 330 * this.SC };
    this.orbit = { ...this.home };
    this.maxDist = atlas.world ? 40000 * this.SC : atlas.asean ? 2400 * this.SC : 900 * this.SC;
    // camera distance (blocks) where the level of detail steps 1→2→4→8; in chunk units so the
    // on-screen face count stays about the same whatever the block size
    this.lodDist = [2 * CHUNK, 5 * CHUNK, 11 * CHUNK];

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DPR));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 260 * this.SC, 900 * this.SC);
    this.camera = new THREE.PerspectiveCamera(50, 1, .05, 6000 * this.SC);

    const tex = this.topTex = new THREE.CanvasTexture(world.canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.topMat = new THREE.MeshBasicMaterial({ map: tex, vertexColors: true, side: THREE.DoubleSide });
    this.sideMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    // Block textures (Minetest Game, CC BY-SA 3.0) for the chunks near the camera
    if (blocks) {
      const btex = new THREE.CanvasTexture(blocks.canvas);
      btex.magFilter = btex.minFilter = THREE.NearestFilter;
      btex.generateMipmaps = false;
      this.texMat = blockMaterial(THREE, btex, blocks.size);
    }
    // Minecraft rail pieces laid on the ground near the camera
    this.pieces = makeAtlas();
    const ptex = new THREE.CanvasTexture(this.pieces.canvas);
    ptex.magFilter = ptex.minFilter = THREE.NearestFilter;
    ptex.generateMipmaps = false;
    this.detailMat = new THREE.MeshBasicMaterial({ map: ptex, alphaTest: .5, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 });

    this._prepare();
    this._buildBackdrop();
    this._buildWater();
    this._buildIcons();
    this._bindInput();
    new ResizeObserver(() => this.resize()).observe(wrap);
    this.resize();
  }

  /* ---------------- height field and levels of detail ---------------- */
  /** Column height in blocks for full-detail block k at the current vertical scale. */
  _height(k) {
    const e = this.cells.elev[k];
    if (this.cells.kind[k] === KIND.WATER) return -Math.max(1, Math.round(Math.sqrt(-e) / 5));
    return Math.max(1, Math.round(e / this.metresPerBlock));
  }

  /** Heights for every block, one down-sampled grid per LOD, and the chunk table (coarsest level built). */
  _prepare() {
    const { W, H, cells } = this;
    const N = W * H;
    const hb = this.hb = new Int16Array(N);
    for (let k = 0; k < N; k++) hb[k] = this._height(k);
    this.lod = {};
    for (const L of LODS) {
      const w = Math.ceil(W / L), h = Math.ceil(H / L);
      const height = new Int16Array(w * h), rep = new Int32Array(w * h);
      for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
        let sum = 0, n = 0;
        for (let y = r * L; y < Math.min(H, r * L + L); y++) for (let x = c * L; x < Math.min(W, c * L + L); x++) { sum += hb[y * W + x]; n++; }
        const k = Math.min(H - 1, r * L + (L >> 1)) * W + Math.min(W - 1, c * L + (L >> 1));
        const water = cells.kind[k] === KIND.WATER;
        let v = Math.round(sum / n);
        v = water ? Math.min(v, -1) : Math.max(v, 1);
        height[r * w + c] = v; rep[r * w + c] = k;
      }
      this.lod[L] = { L, w, h, height, rep };
    }
    this._resetChunks();
  }

  /** Throw away all chunk meshes and rebuild the coarsest level; finer ones rebuild on demand. */
  _resetChunks() {
    const { W, H } = this;
    for (const c of this.chunks?.values() || []) for (const m of Object.values(c.meshes)) if (m) this._dispose(m);
    this._clearDetail();
    this.chunks = new Map();
    this.nx = Math.ceil(W / CHUNK); this.nz = Math.ceil(H / CHUNK);
    for (let j = 0; j < this.nz; j++) for (let i = 0; i < this.nx; i++) {
      const chunk = { i, j, meshes: {}, shown: 0,
        cx: (i + .5) * CHUNK - W / 2, cz: (j + .5) * CHUNK - H / 2 };
      this.chunks.set(j * this.nx + i, chunk);
      this._show(chunk, LODS[LODS.length - 1]);
    }
  }

  /** Build the meshes for one chunk at one level of detail. */
  _buildChunk(chunk, L) {
    const { T, W, H, cells, atlas } = this;
    const { kind, col } = cells;
    const grid = atlas.grid;
    const hb = this.hb;
    const G = this.lod[L];
    const per = CHUNK / L;
    const c0 = chunk.i * per, r0 = chunk.j * per;
    const c1 = Math.min(G.w, c0 + per), r1 = Math.min(G.h, r0 + per);
    const cw = c1 - c0;
    const ht = (r, c) => G.height[r * G.w + c];
    const rep = (r, c) => G.rep[r * G.w + c];
    // Neighbour height for a wall. Inside the chunk use the same LOD; across the chunk edge
    // use the lowest full-detail block along that edge, so neighbours drawn at a different
    // LOD never leave a gap.
    const neighbour = (r, c, dr, dc) => {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= G.h || cc >= G.w) return MIN_Y;
      if (rr >= r0 && rr < r1 && cc >= c0 && cc < c1) return ht(rr, cc);
      let m = Infinity;
      if (dr) { const y = dr < 0 ? r * L - 1 : Math.min(H - 1, (r + 1) * L); for (let x = c * L; x < Math.min(W, c * L + L); x++) m = Math.min(m, hb[y * W + x]); }
      else { const x = dc < 0 ? c * L - 1 : Math.min(W - 1, (c + 1) * L); for (let y = r * L; y < Math.min(H, r * L + L); y++) m = Math.min(m, hb[y * W + x]); }
      return Math.min(m, ht(rr, cc));
    };
    const X = c => Math.min(W, c * L) - W / 2, Z = r => Math.min(H, r * L) - H / 2;

    const count = [0, 0];
    let buf = null;
    const quad = (m, v, rgb, f, uv) => {
      const q = count[m]++;
      if (!buf) return q;
      const b = buf[m], o = q * 12;
      b.pos.set(v, o);
      const r = rgb[0] * f / 255, g = rgb[1] * f / 255, bl = rgb[2] * f / 255;
      for (let i = 0; i < 4; i++) { b.clr[o + i * 3] = r; b.clr[o + i * 3 + 1] = g; b.clr[o + i * 3 + 2] = bl; }
      if (uv) b.uv.set(uv, q * 8);
      return q;
    };
    const WHITE = [255, 255, 255];
    const isLeafy = kd => kd === KIND.TREE || kd === KIND.FOREIGN_TREE;
    const isGrassy = kd => kd === KIND.GRASS || kd === KIND.PADDY || kd === KIND.FOREIGN;
    const topRGB = (k, h) => kind[k] === KIND.WATER
      ? (h > -3 ? [196, 182, 132] : [128, 124, 118])            // sand shallows, gravel deeper
      : [col[k * 3], col[k * 3 + 1], col[k * 3 + 2]];
    const wall = (r, c, hn, f, verts) => {
      const k = rep(r, c), h = ht(r, c), kd = kind[k], jit = .95 + h2(k, 1, 17) * .1;
      const side = kd === KIND.WATER ? [150, 140, 110] : isGrassy(kd) ? DIRT : topRGB(k, h);
      if ((isGrassy(kd) || isLeafy(kd)) && h - hn >= 1) {
        const lip = isLeafy(kd) ? .6 : .2;
        quad(1, verts(h - lip, h), topRGB(k, h), f * jit);
        quad(1, verts(hn, h - lip), isLeafy(kd) ? LOG : side, f * jit);
      } else {
        quad(1, verts(hn, h), side, f * jit);
      }
    };
    const same = (r, a, b) => ht(r, a) === ht(r, b) && kind[rep(r, a)] === kind[rep(r, b)] && grid[rep(r, a)] === grid[rep(r, b)];
    const sameCol = (c, a, b) => ht(a, c) === ht(b, c) && kind[rep(a, c)] === kind[rep(b, c)] && grid[rep(a, c)] === grid[rep(b, c)];
    const topQuad = new Int32Array(cw * (r1 - r0)).fill(-1);
    const pass = () => {
      count[0] = count[1] = 0;
      for (let r = r0; r < r1; r++) {
        const z0 = Z(r), z1 = Z(r + 1);
        for (let c = c0; c < c1;) {                          // tops, merged along the row
          let e = c + 1;
          while (e < c1 && same(r, e, c)) e++;
          const k = rep(r, c), h = ht(r, c), x0 = X(c), x1 = X(e);
          const v = [x0, h, z0, x0, h, z1, x1, h, z1, x1, h, z0];
          if (kind[k] === KIND.WATER) quad(1, v, topRGB(k, h), 1);
          else {
            const u0 = (x0 + W / 2) / W, u1 = (x1 + W / 2) / W, v0 = 1 - (z0 + H / 2) / H, v1 = 1 - (z1 + H / 2) / H;
            const q = quad(0, v, WHITE, 1, [u0, v0, u0, v1, u1, v1, u1, v0]);
            if (buf) for (let i = c; i < e; i++) topQuad[(r - r0) * cw + (i - c0)] = q;
          }
          c = e;
        }
        for (const dr of [-1, 1]) {                          // north / south walls
          const z = dr < 0 ? z0 : z1;
          for (let c = c0; c < c1;) {
            const hn = neighbour(r, c, dr, 0);
            let e = c + 1;
            while (e < c1 && same(r, e, c) && neighbour(r, e, dr, 0) === hn) e++;
            if (hn < ht(r, c)) {
              const xa = X(c), xb = X(e);
              wall(r, c, hn, SHADE.ns, dr < 0
                ? (lo, hi) => [xb, lo, z, xb, hi, z, xa, hi, z, xa, lo, z]
                : (lo, hi) => [xa, lo, z, xa, hi, z, xb, hi, z, xb, lo, z]);
            }
            c = e;
          }
        }
      }
      for (let c = c0; c < c1; c++) {                        // west / east walls, merged down the column
        for (const dc of [-1, 1]) {
          const x = dc < 0 ? X(c) : X(c + 1);
          for (let r = r0; r < r1;) {
            const hn = neighbour(r, c, 0, dc);
            let e = r + 1;
            while (e < r1 && sameCol(c, e, r) && neighbour(e, c, 0, dc) === hn) e++;
            if (hn < ht(r, c)) {
              const za = Z(r), zb = Z(e);
              wall(r, c, hn, SHADE.ew, dc < 0
                ? (lo, hi) => [x, lo, za, x, hi, za, x, hi, zb, x, lo, zb]
                : (lo, hi) => [x, lo, zb, x, hi, zb, x, hi, za, x, lo, za]);
            }
            r = e;
          }
        }
      }
    };
    pass();
    const mk = (n, uv) => ({ n, pos: new Float32Array(n * 12), clr: new Float32Array(n * 12), uv: uv ? new Float32Array(n * 8) : null });
    buf = [mk(count[0], true), mk(count[1], false)];
    pass();

    const group = new T.Group();
    const geos = buf.map(b => {
      const idx = new Uint32Array(b.n * 6);
      for (let q = 0; q < b.n; q++) {
        const v = q * 4, o = q * 6;
        idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2; idx[o + 3] = v; idx[o + 4] = v + 2; idx[o + 5] = v + 3;
      }
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(b.pos, 3));
      geo.setAttribute('color', b.attr = new T.BufferAttribute(b.clr, 3));
      if (b.uv) geo.setAttribute('uv', new T.BufferAttribute(b.uv, 2));
      geo.setIndex(new T.BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      return geo;
    });
    group.add(new T.Mesh(geos[0], this.topMat), new T.Mesh(geos[1], this.sideMat));
    return { L, group, geos, tops: buf[0], base: buf[0].clr.slice(), topQuad,
      r0, r1, c0, c1, cw, quads: count[0] + count[1], hl: '' };
  }

  /**
   * Close-up chunk with real block textures: grass (dry grass in Isan), dirt, stone, sand,
   * leaves, river water, stone and dirt-path roads, gravel under rails; walls show grass-side
   * over dirt like Minecraft. Same merging and gap-free chunk edges as _buildChunk.
   */
  _buildChunkTextured(chunk, L) {
    const { T, W, H, cells, atlas, blocks } = this;
    const { kind } = cells;
    const grid = atlas.grid, hb = this.hb, roads = atlas.roads, streams = atlas.streams, layers = this.layers;
    const G = this.lod[L];
    const per = CHUNK / L;
    const c0 = chunk.i * per, r0 = chunk.j * per;
    const c1 = Math.min(G.w, c0 + per), r1 = Math.min(G.h, r0 + per);
    const cw = c1 - c0;
    const ht = (r, c) => G.height[r * G.w + c];
    const rep = (r, c) => G.rep[r * G.w + c];
    const neighbour = (r, c, dr, dc) => {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= G.h || cc >= G.w) return MIN_Y;
      if (rr >= r0 && rr < r1 && cc >= c0 && cc < c1) return ht(rr, cc);
      let m = Infinity;
      if (dr) { const y = dr < 0 ? r * L - 1 : Math.min(H - 1, (r + 1) * L); for (let x = c * L; x < Math.min(W, c * L + L); x++) m = Math.min(m, hb[y * W + x]); }
      else { const x = dc < 0 ? c * L - 1 : Math.min(W - 1, (c + 1) * L); for (let y = r * L; y < Math.min(H, r * L + L); y++) m = Math.min(m, hb[y * W + x]); }
      return Math.min(m, ht(rr, cc));
    };
    const X = c => Math.min(W, c * L) - W / 2, Z = r => Math.min(H, r * L) - H / 2;
    const T_ = n => blocks.tile(n);
    const topName = k => blockTexture(k, atlas, cells, layers, hb);
    const SIDE = { grass: ['grass_side', 'dirt'], dry_grass: ['dry_grass_side', 'dirt'], river_water: ['dirt', 'dirt'],
      dry_dirt: ['dirt', 'dirt'], leaves: ['leaves', 'tree'], jungleleaves: ['jungleleaves', 'tree'] };
    const tint = k => {
      const v = grid[k], j = .94 + h2(k, 1, 17) * .1;
      const f = v >= 0 ? (SHADES[this.atlas.provinces[v].shade] || 1) * .5 + .5 : v === -2 ? .82 : 1;
      const paddy = kind[k] === KIND.PADDY ? [1.02, 1.1, .9] : [1, 1, 1];
      return paddy.map(q => q * f * j);
    };
    const tiles = new Int16Array(cw * (r1 - r0));
    const names = [];
    for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) {
      const n = topName(rep(r, c));
      let i = names.indexOf(n);
      if (i < 0) { i = names.length; names.push(n); }
      tiles[(r - r0) * cw + (c - c0)] = i;
    }
    const tileAt = (r, c) => tiles[(r - r0) * cw + (c - c0)];
    const count = [0];
    let buf = null;
    const quad = (v, tileName, rgb, f, uv) => {
      const q = count[0]++;
      if (!buf) return q;
      const o = q * 12, [tu, tv] = blocks.origin(T_(tileName));
      buf.pos.set(v, o); buf.uv.set(uv, q * 8);
      for (let i = 0; i < 4; i++) {
        buf.tile[q * 8 + i * 2] = tu; buf.tile[q * 8 + i * 2 + 1] = tv;
        buf.clr[o + i * 3] = rgb[0] * f; buf.clr[o + i * 3 + 1] = rgb[1] * f; buf.clr[o + i * 3 + 2] = rgb[2] * f;
      }
      return q;
    };
    const wall = (r, c, hn, f, verts, len) => {
      const k = rep(r, c), h = ht(r, c), top = names[tileAt(r, c)], rgb = tint(k);
      const [upper, lower] = SIDE[top] || [top, top];
      if (h - hn > 1) {
        quad(verts(h - 1, h), upper, rgb, f, [0, 0, 0, 1, len, 1, len, 0]);
        quad(verts(hn, h - 1), lower, rgb, f, [0, 0, 0, h - 1 - hn, len, h - 1 - hn, len, 0]);
      } else {
        quad(verts(hn, h), upper, rgb, f, [0, 0, 0, h - hn, len, h - hn, len, 0]);
      }
    };
    const same = (r, a, b) => ht(r, a) === ht(r, b) && tileAt(r, a) === tileAt(r, b) && grid[rep(r, a)] === grid[rep(r, b)];
    const sameCol = (c, a, b) => ht(a, c) === ht(b, c) && tileAt(a, c) === tileAt(b, c) && grid[rep(a, c)] === grid[rep(b, c)];
    const topQuad = new Int32Array(cw * (r1 - r0)).fill(-1);
    const pass = () => {
      count[0] = 0;
      for (let r = r0; r < r1; r++) {
        const z0 = Z(r), z1 = Z(r + 1);
        for (let c = c0; c < c1;) {
          let e = c + 1;
          while (e < c1 && same(r, e, c)) e++;
          const k = rep(r, c), h = ht(r, c), x0 = X(c), x1 = X(e);
          const q = quad([x0, h, z0, x0, h, z1, x1, h, z1, x1, h, z0], names[tileAt(r, c)], tint(k), 1,
            [0, 0, 0, z1 - z0, x1 - x0, z1 - z0, x1 - x0, 0]);
          if (buf && kind[k] !== KIND.WATER) for (let i = c; i < e; i++) topQuad[(r - r0) * cw + (i - c0)] = q;
          c = e;
        }
        for (const dr of [-1, 1]) {
          const z = dr < 0 ? z0 : z1;
          for (let c = c0; c < c1;) {
            const hn = neighbour(r, c, dr, 0);
            let e = c + 1;
            while (e < c1 && same(r, e, c) && neighbour(r, e, dr, 0) === hn) e++;
            if (hn < ht(r, c)) {
              const xa = X(c), xb = X(e);
              wall(r, c, hn, SHADE.ns, dr < 0
                ? (lo, hi) => [xb, lo, z, xb, hi, z, xa, hi, z, xa, lo, z]
                : (lo, hi) => [xa, lo, z, xa, hi, z, xb, hi, z, xb, lo, z], xb - xa);
            }
            c = e;
          }
        }
      }
      for (let c = c0; c < c1; c++) {
        for (const dc of [-1, 1]) {
          const x = dc < 0 ? X(c) : X(c + 1);
          for (let r = r0; r < r1;) {
            const hn = neighbour(r, c, 0, dc);
            let e = r + 1;
            while (e < r1 && sameCol(c, e, r) && neighbour(e, c, 0, dc) === hn) e++;
            if (hn < ht(r, c)) {
              const za = Z(r), zb = Z(e);
              wall(r, c, hn, SHADE.ew, dc < 0
                ? (lo, hi) => [x, lo, za, x, hi, za, x, hi, zb, x, lo, zb]
                : (lo, hi) => [x, lo, zb, x, hi, zb, x, hi, za, x, lo, za], zb - za);
            }
            r = e;
          }
        }
      }
    };
    pass();
    const n = count[0];
    buf = { n, pos: new Float32Array(n * 12), uv: new Float32Array(n * 8), tile: new Float32Array(n * 8), clr: new Float32Array(n * 12) };
    pass();
    const idx = new Uint32Array(n * 6);
    for (let q = 0; q < n; q++) {
      const v = q * 4, o = q * 6;
      idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2; idx[o + 3] = v; idx[o + 4] = v + 2; idx[o + 5] = v + 3;
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(buf.pos, 3));
    geo.setAttribute('uv', new T.BufferAttribute(buf.uv, 2));
    geo.setAttribute('tile', new T.BufferAttribute(buf.tile, 2));
    geo.setAttribute('tint', buf.attr = new T.BufferAttribute(buf.clr, 3));
    geo.setIndex(new T.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    const group = new T.Group();
    group.add(new T.Mesh(geo, this.texMat));
    return { L, group, geos: [geo], tops: buf, base: buf.clr.slice(), topQuad, r0, r1, c0, c1, cw, quads: n, hl: '' };
  }

  /**
   * Connected rail pieces on the blocks around the look-at point, rebuilt when the
   * point moves; hidden when the camera is far away (they would be smaller than a pixel).
   */
  _updateDetail() {
    const o = this.orbit;
    if (o.dist > DETAIL_CAMERA) { if (this.detail) this.detail.group.visible = false; return; }
    const c = Math.round(o.x + this.W / 2), r = Math.round(o.z + this.H / 2);
    const d = this.detail;
    if (d && Math.abs(d.c - c) < 10 && Math.abs(d.r - r) < 10) { d.group.visible = true; return; }
    this._clearDetail();
    this.detail = this._buildDetail(c, r);
    this.scene.add(this.detail.group);
  }

  _clearDetail() {
    if (this.detail) { this._dispose(this.detail); this.detail = null; }
  }

  _buildDetail(cc, rc) {
    const { T, W, H, atlas, pieces } = this;
    const hb = this.hb, roads = atlas.roads;
    const isRail = (r, c) => r >= 0 && c >= 0 && r < H && c < W && roads[r * W + c] === 5;
    const pos = [], uv = [];
    if (roads && this.layers.rails) {
      for (let r = Math.max(0, rc - DETAIL_RADIUS); r <= Math.min(H - 1, rc + DETAIL_RADIUS); r++) {
        for (let c = Math.max(0, cc - DETAIL_RADIUS); c <= Math.min(W - 1, cc + DETAIL_RADIUS); c++) {
          if (roads[r * W + c] !== 5 || (r - rc) ** 2 + (c - cc) ** 2 > DETAIL_RADIUS ** 2) continue;
          const [u0, v0, u1, v1] = pieces.uv(maskAt(r, c, isRail));
          const x = c - W / 2, z = r - H / 2, y = Math.max(hb[r * W + c], .2) + .01;
          // corners NW, SW, SE, NE; piece rows run north (top of the tile) to south
          pos.push(x, y, z, x, y, z + 1, x + 1, y, z + 1, x + 1, y, z);
          uv.push(u0, v1, u0, v0, u1, v0, u1, v1);
        }
      }
    }
    const n = pos.length / 12;
    const idx = new Uint32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const v = i * 4, o = i * 6;
      idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2; idx[o + 3] = v; idx[o + 4] = v + 2; idx[o + 5] = v + 3;
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('uv', new T.BufferAttribute(new Float32Array(uv), 2));
    geo.setIndex(new T.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    const group = new T.Group();
    group.add(new T.Mesh(geo, this.detailMat));
    return { group, geos: [geo], quads: n, c: cc, r: rc };
  }

  _dispose(mesh) {
    this.scene.remove(mesh.group);
    for (const g of mesh.geos) g.dispose();
  }

  /** Make level L the visible mesh for a chunk (building it now if needed). */
  _show(chunk, L) {
    if (!chunk.meshes[L]) {
      chunk.meshes[L] = this.texMat && L <= TEXTURED_LOD ? this._buildChunkTextured(chunk, L) : this._buildChunk(chunk, L);
      this.scene.add(chunk.meshes[L].group);
    }
    for (const [lv, m] of Object.entries(chunk.meshes)) if (m) m.group.visible = +lv === L;
    chunk.shown = L;
    this._highlight(chunk.meshes[L]);
  }

  /** Pick each chunk's level from camera distance; build missing levels within a time budget. */
  _updateLOD() {
    const p = this.camera.position;
    const want = [];
    for (const chunk of this.chunks.values()) {
      const d = Math.hypot(chunk.cx - p.x, chunk.cz - p.z, p.y * .6);
      const L = d < this.lodDist[0] ? 1 : d < this.lodDist[1] ? 2 : d < this.lodDist[2] ? 4 : 8;
      chunk.dist = d;
      if (chunk.shown !== L) {
        if (chunk.meshes[L]) this._show(chunk, L);
        else want.push([d, chunk, L]);
      }
    }
    want.sort((a, b) => a[0] - b[0]);
    const t0 = performance.now();
    for (const [, chunk, L] of want) {
      if (performance.now() - t0 > BUILD_BUDGET_MS) break;
      this._show(chunk, L);
    }
    // Free detailed meshes of chunks that are now far away
    for (const chunk of this.chunks.values()) {
      for (const [i, L] of [1, 2, 4].entries()) {
        const m = chunk.meshes[L];
        if (m && chunk.shown !== L && chunk.dist > this.lodDist[i] * 1.6) { this._dispose(m); chunk.meshes[L] = null; }
      }
    }
  }

  _buildWater() {
    const { T, W, H } = this;
    const [x0, z0, x1, z1] = this.bounds;
    const geo = new T.PlaneGeometry(x1 - x0 + 400 * this.SC, z1 - z0 + 400 * this.SC);
    geo.rotateX(-Math.PI / 2);
    const mat = new T.MeshBasicMaterial({ color: 0x3f76e4, transparent: true, opacity: .62, depthWrite: false });
    this.water = new T.Mesh(geo, mat);
    this.water.position.set((x0 + x1) / 2, .15, (z0 + z1) / 2);
    this.scene.add(this.water);
  }

  /**
   * Low-detail backdrops as coarse block columns (every 4th backdrop block: 1° for the world,
   * 0.2° for the ASEAN region), coloured from their 2D canvases and raised to real elevation.
   * Each leaves out the area a finer layer covers (the world skips the ASEAN box, the ASEAN
   * region skips the detailed Thailand window). Also sets this.bounds (x/z the camera may pan over).
   */
  _buildBackdrop() {
    const { T, W, H, atlas } = this;
    const map = atlas.map;
    for (const m of this.backMeshes || []) { this.scene.remove(m.mesh); m.geo.dispose(); }
    this.backMeshes = [];
    this.bounds = [-W / 2, -H / 2, W / 2, H / 2];
    const X = lon => (lon - map.lon0) / map.S - W / 2, Z = lat => (map.lat1 - lat) / map.S - H / 2;
    const thai = [map.lon0, map.lat1 - map.H * map.S, map.lon0 + map.W * map.S, map.lat1];
    const box = a => [a.lon0, a.lat1 - a.H * a.S, a.lon0 + a.W * a.S, a.lat1];
    const inBox = (b, lon, lat) => b && lon > b[0] && lon < b[2] && lat > b[1] && lat < b[3];
    this.backQuads = 0;
    for (const { data: A, canvas } of this.backdrops) {
      const hole = A === atlas.world && atlas.asean ? box(atlas.asean) : thai;
      const D = 4, S = A.S * D;
      const w = Math.floor(A.W / D), h = Math.floor(A.H / D);
      const bx = [X(A.lon0), Z(A.lat1), X(A.lon0 + w * S), Z(A.lat1 - h * S)];
      this.bounds = [Math.min(this.bounds[0], bx[0]), Math.min(this.bounds[1], bx[1]), Math.max(this.bounds[2], bx[2]), Math.max(this.bounds[3], bx[3])];
      const colours = canvas.getContext('2d').getImageData(0, 0, A.W, A.H).data;
      const inside = (r, c) => inBox(hole, A.lon0 + (c + .5) * S, A.lat1 - (r + .5) * S);
      const ht = new Int16Array(w * h);
      for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
        const k = (r * D + (D >> 1)) * A.W + c * D + (D >> 1);
        const e = A.elev ? A.elev[k] : 0;
        ht[r * w + c] = A.grid[k] === 0 ? -Math.max(1, Math.round(Math.sqrt(Math.max(-e, 1)) / 5)) : Math.max(1, Math.round(e / this.metresPerBlock));
      }
      const pos = [], clr = [];
      const quad = (v, k, f) => {
        pos.push(...v);
        const r = colours[k * 4] / 255 * f, g = colours[k * 4 + 1] / 255 * f, b = colours[k * 4 + 2] / 255 * f;
        for (let i = 0; i < 4; i++) clr.push(r, g, b);
      };
      const at = (r, c) => (r < 0 || c < 0 || r >= h || c >= w || inside(r, c)) ? MIN_Y : ht[r * w + c];
      for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
        if (inside(r, c)) continue;
        const k = (r * D + (D >> 1)) * A.W + c * D + (D >> 1), y = ht[r * w + c];
        const x0 = X(A.lon0 + c * S), x1 = X(A.lon0 + (c + 1) * S), z0 = Z(A.lat1 - r * S), z1 = Z(A.lat1 - (r + 1) * S);
        quad([x0, y, z0, x0, y, z1, x1, y, z1, x1, y, z0], k, 1);
        const walls = [
          [at(r - 1, c), .8, lo => [x1, lo, z0, x1, y, z0, x0, y, z0, x0, lo, z0]],
          [at(r + 1, c), .8, lo => [x0, lo, z1, x0, y, z1, x1, y, z1, x1, lo, z1]],
          [at(r, c - 1), .62, lo => [x0, lo, z0, x0, y, z0, x0, y, z1, x0, lo, z1]],
          [at(r, c + 1), .62, lo => [x1, lo, z1, x1, y, z1, x1, y, z0, x1, lo, z0]],
        ];
        for (const [hn, f, v] of walls) if (hn < y) quad(v(Math.max(hn, MIN_Y)), k, f * .75);
      }
      const n = pos.length / 12, idx = new Uint32Array(n * 6);
      for (let q = 0; q < n; q++) { const v = q * 4, o = q * 6; idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2; idx[o + 3] = v; idx[o + 4] = v + 2; idx[o + 5] = v + 3; }
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(new Float32Array(pos), 3));
      geo.setAttribute('color', new T.BufferAttribute(new Float32Array(clr), 3));
      geo.setIndex(new T.BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      const mesh = new T.Mesh(geo, this.sideMat);
      this.scene.add(mesh);
      this.backMeshes.push({ mesh, geo });
      this.backQuads += n;
    }
  }

  /* ---------------- selection highlight ---------------- */
  /** Tint the tops of the selected province (and focused district) yellow in one chunk mesh. */
  _highlight(mesh) {
    const sel = this.selected;
    const key = `${sel}:${this.dFocus}:${this.layer ? this.layer.slug : ''}`;
    if (mesh.hl === key) return;
    const { W, atlas } = this;
    const L = mesh.L;
    const b = sel >= 0 ? atlas.provinces[sel].bb : null;
    const touches = b && b[2] >= mesh.c0 * L && b[0] < mesh.c1 * L && b[3] >= mesh.r0 * L && b[1] < mesh.r1 * L;
    const clr = mesh.tops.clr;
    if (!touches && !mesh.tinted) { mesh.hl = key; return; }
    clr.set(mesh.base);
    mesh.tinted = false;
    if (touches) {
      const G = this.lod[L], done = new Set();
      for (let r = mesh.r0; r < mesh.r1; r++) for (let c = mesh.c0; c < mesh.c1; c++) {
        const q = mesh.topQuad[(r - mesh.r0) * mesh.cw + (c - mesh.c0)];
        const k = G.rep[r * G.w + c];
        if (q < 0 || done.has(q) || atlas.grid[k] !== sel) continue;
        done.add(q);
        mesh.tinted = true;
        const fr = (k / W) | 0, fc = k % W;
        const mix = this.layer && this.dFocus >= 0 && this.layer.hit((fc + .5) * B, (fr + .5) * B) === this.dFocus ? .7 : .3;
        const o = q * 12;
        for (let i = 0; i < 12; i += 3) {
          clr[o + i] = clr[o + i] * (1 - mix) + 1.15 * mix;
          clr[o + i + 1] = clr[o + i + 1] * (1 - mix) + 1.1 * mix;
          clr[o + i + 2] = clr[o + i + 2] * (1 - mix) + .45 * mix;
        }
      }
    }
    mesh.tops.attr.needsUpdate = true;
    mesh.hl = key;
  }

  _applyHighlight() {
    for (const chunk of this.chunks.values()) {
      const m = chunk.meshes[chunk.shown];
      if (m) this._highlight(m);
    }
  }

  /* ---------------- icons ---------------- */
  _spriteMat(canvas) {
    const tex = new this.T.CanvasTexture(canvas);
    tex.magFilter = tex.minFilter = this.T.NearestFilter;
    return new this.T.SpriteMaterial({ map: tex, transparent: true, fog: false });
  }

  _buildIcons() {
    const { T, W, H, atlas } = this;
    this.icons = atlas.provinces.map(p => {
      const s = new T.Sprite(this._spriteMat(itemSprite(p).canvas));
      const [r, c] = p.anchor;
      s.userData = { r, c, base: 0 };
      s.position.set(c + .5 - W / 2, 0, r + .5 - H / 2);
      this.scene.add(s);
      return s;
    });
    this.districtIcons = [];
    this._placeIcons();
  }

  _placeIcons() {
    const { W } = this;
    this.icons.forEach((s, i) => {
      const { r, c } = s.userData;
      s.userData.base = Math.max(this.hb[r * W + c], 0) + 4 * this.SC;
      const big = i === this.selected || i === this.hover;
      const z = (big ? 7 : 5) * this.SC;
      s.scale.set(z, z, 1);
      s.visible = !(i === this.selected && this.districtIcons.length);
    });
    for (const s of this.districtIcons) {
      const { r, c } = s.userData;
      s.userData.base = Math.max(this.hb[r * W + c], 0) + 2.2 * this.SC;
      const z = (s.userData.k === this.dFocus ? 3.4 : 2.4) * this.SC;
      s.scale.set(z, z, 1);
    }
  }

  /* ---------------- state from main ---------------- */
  setSelected(i) {
    this.selected = i; this.dFocus = -1;
    this.setDistrictLayer(null);
  }

  setHover(i) {
    if (i === this.hover) return;
    this.hover = i;
    this._placeIcons();
  }

  setDistrictLayer(layer) {
    this.layer = layer;
    for (const s of this.districtIcons) { this.scene.remove(s); s.material.map.dispose(); s.material.dispose(); }
    this.districtIcons = [];
    if (layer) {
      const { W, H } = this;
      layer.districts.forEach((d, k) => {
        const a = layer.anchor(k);
        if (!a) return;
        const x = a[0] / B, z = a[1] / B;
        const s = new this.T.Sprite(this._spriteMat(layer.sprite(k).canvas));
        s.userData = { k, r: Math.min(H - 1, Math.floor(z)), c: Math.min(W - 1, Math.floor(x)), base: 0 };
        s.position.set(x - W / 2, 0, z - H / 2);
        this.scene.add(s);
        this.districtIcons.push(s);
      });
    }
    this._placeIcons();
    this._applyHighlight();
  }

  setDistrictFocus(k) { this.dFocus = k; this._placeIcons(); this._applyHighlight(); }

  /** Layers changed: the 2D terrain canvas (our top texture) was redrawn; rebuild buildings. */
  setLayers(layers) {
    this.topTex.needsUpdate = true;
    const keys = ['mainRoads', 'mediumRoads', 'rails', 'rivers', 'streams'];
    const changed = keys.some(k => layers[k] !== this.layers[k]);
    this.layers = { ...layers };
    if (changed) {
      this._clearDetail();
      // textured close-up chunks bake roads, rails and rivers into their block choice
      for (const c of this.chunks.values()) for (const L of [1, 2]) {
        const m = c.meshes[L];
        if (m) { this._dispose(m); c.meshes[L] = null; if (c.shown === L) c.shown = 0; }
      }
    }
  }
  setDistrictHover() {}

  setVerticalScale(metresPerBlock) {
    this.metresPerBlock = metresPerBlock;
    this._prepare();
    this._buildBackdrop();
    this._placeIcons();
  }

  /* ---------------- camera ---------------- */
  setActive(on) {
    this.active = on;
    if (on) { this.resize(); requestAnimationFrame(t => this._loop(t)); }
  }

  resize() {
    const r = this.wrap.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
    this.cw = r.width; this.ch = r.height;
  }

  _goTo(target) {
    if (reduced) { Object.assign(this.orbit, target); return; }
    this.tween = { a: { ...this.orbit }, b: { ...this.orbit, ...target }, t0: performance.now(), d: 700 };
  }

  focusProvince(i) {
    const b = this.atlas.provinces[i].bb;
    const size = Math.max(b[2] - b[0], b[3] - b[1]) + 1;
    this._goTo({ x: (b[0] + b[2] + 1) / 2 - this.W / 2, z: (b[1] + b[3] + 1) / 2 - this.H / 2 + size * .15, dist: size * 1.9 + 30 * this.SC });
  }

  focusDistrict(k) {
    const b = this.layer?.bb[k];
    if (!b || !isFinite(b[0])) return;
    const size = Math.max(b[2] - b[0], b[3] - b[1]) / B;
    this._goTo({ x: (b[0] + b[2]) / 2 / B - this.W / 2, z: (b[1] + b[3]) / 2 / B - this.H / 2, dist: size * 2.4 + 18 * this.SC });
  }

  fit() { this._goTo({ ...this.home }); }
  zoom(f) { this.tween = null; this.orbit.dist = Math.min(this.maxDist, Math.max(1.5, this.orbit.dist / f)); }

  _updateCamera() {
    const o = this.orbit;
    const cp = Math.cos(o.pitch);
    const ty = Math.max(this._groundAt(o.x, o.z), 0);
    this.camera.position.set(o.x + Math.sin(o.yaw) * cp * o.dist, ty + Math.sin(o.pitch) * o.dist, o.z + Math.cos(o.yaw) * cp * o.dist);
    this.camera.lookAt(o.x, ty, o.z);
  }

  _groundAt(x, z) {
    const c = Math.floor(x + this.W / 2), r = Math.floor(z + this.H / 2);
    if (c < 0 || r < 0 || c >= this.W || r >= this.H) return 0;
    return this.hb[r * this.W + c];
  }

  /* ---------------- picking ---------------- */
  /** Ray-march the full-detail height field under a screen point. */
  pick(sx, sy) {
    const T = this.T;
    const ndc = new T.Vector2(sx / this.cw * 2 - 1, -(sy / this.ch) * 2 + 1);
    const ray = new T.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const o = ray.ray.origin, d = ray.ray.direction;
    const { W, H } = this;
    for (let t = 0; t < 3000 * this.SC; t += Math.max(.35, t * .0015)) {
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      const c = Math.floor(x + W / 2), r = Math.floor(z + H / 2);
      if (c < 0 || r < 0 || c >= W || r >= H) { if (y < MIN_Y) return null; continue; }
      const k = r * W + c;
      if (y <= Math.max(this.hb[k], 0)) {
        const v = this.atlas.grid[k];
        let province = v >= 0 ? v : -1, district = -1;
        if (this.layer) {
          district = this.layer.hit((x + W / 2) * B, (z + H / 2) * B);
          if (district >= 0) province = this.selected;
        }
        return { r, c, v, province, district };
      }
    }
    return null;
  }

  /* ---------------- input ---------------- */
  _bindInput() {
    const cv = this.canvas, pts = new Map();
    let down = null, pinch = null;
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('pointerdown', e => {
      cv.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      this.tween = null;
      if (pts.size === 1) down = { x: e.offsetX, y: e.offsetY, lx: e.offsetX, ly: e.offsetY, moved: false, pan: e.button === 2 || e.shiftKey };
      else if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), dist: this.orbit.dist, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        if (down) down.moved = true;
      }
    });
    cv.addEventListener('pointermove', e => {
      if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      const o = this.orbit;
      if (pinch && pts.size >= 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        o.dist = Math.min(this.maxDist, Math.max(1.5, pinch.dist * pinch.d / d));
        this._pan(mx - pinch.mx, my - pinch.my);
        pinch.mx = mx; pinch.my = my;
        return;
      }
      if (down && pts.size === 1) {
        const dx = e.offsetX - down.lx, dy = e.offsetY - down.ly;
        down.lx = e.offsetX; down.ly = e.offsetY;
        if (Math.abs(e.offsetX - down.x) + Math.abs(e.offsetY - down.y) > 5) down.moved = true;
        if (down.moved) {
          if (down.pan) this._pan(dx, dy);
          else { o.yaw -= dx * .006; o.pitch = Math.min(1.48, Math.max(.12, o.pitch + dy * .005)); }
          this.onHover(null, e);
          return;
        }
      }
      if (e.pointerType === 'mouse' && !this._hoverPending) {
        this._hoverPending = true;
        requestAnimationFrame(() => {
          this._hoverPending = false;
          const pk = this.pick(e.offsetX, e.offsetY);
          this.setHover(pk ? pk.province : -1);
          cv.classList.toggle('over', !!pk && pk.province >= 0);
          this.onHover(pk, e);
        });
      }
    });
    const end = e => {
      const wasClick = down && !down.moved && pts.size === 1;
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 0) {
        if (wasClick && e.type === 'pointerup' && e.button !== 2) {
          const pk = this.pick(e.offsetX, e.offsetY);
          if (pk && pk.province >= 0) this.onClick(pk);
        }
        down = null;
      } else if (pts.size === 1) {
        const [p] = [...pts.values()];
        down = { x: p.x, y: p.y, lx: p.x, ly: p.y, moved: true, pan: false };
      }
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { this.setHover(-1); this.onHover(null, e); } });
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      this.tween = null;
      this.orbit.dist = Math.min(this.maxDist, Math.max(1.5, this.orbit.dist * Math.exp(e.deltaY * (e.deltaMode === 1 ? .04 : .0012))));
    }, { passive: false });
  }

  /** Move the orbit target along the ground by a screen-space drag. */
  _pan(dx, dy) {
    const o = this.orbit;
    const k = o.dist / Math.max(this.ch, 1) * 1.1;
    const s = Math.sin(o.yaw), c = Math.cos(o.yaw);
    o.x += (-dx * c - dy * s / Math.max(Math.sin(o.pitch), .3)) * k;
    o.z += (dx * s - dy * c / Math.max(Math.sin(o.pitch), .3)) * k;
    const [bx0, bz0, bx1, bz1] = this.bounds;
    o.x = Math.max(bx0, Math.min(bx1, o.x));
    o.z = Math.max(bz0, Math.min(bz1, o.z));
  }

  /* ---------------- frame ---------------- */
  _loop(t) {
    if (!this.active) return;
    const tw = this.tween;
    if (tw) {
      const k = Math.min(1, (t - tw.t0) / tw.d), e = 1 - Math.pow(1 - k, 3);
      for (const key of ['x', 'z', 'yaw', 'pitch', 'dist']) this.orbit[key] = tw.a[key] + (tw.b[key] - tw.a[key]) * e;
      if (k >= 1) this.tween = null;
    }
    const bob = i => reduced ? 0 : Math.sin(t / 520 + i * 1.7) * .35 * this.SC;
    this.icons.forEach((s, i) => { s.position.y = s.userData.base + bob(i); });
    this.districtIcons.forEach((s, i) => { s.position.y = s.userData.base + bob(i) * .6; });
    this._updateCamera();
    // fog follows the camera distance so the whole of ASEAN can be seen when zoomed out
    this.scene.fog.near = this.orbit.dist * 1.1;
    this.scene.fog.far = this.orbit.dist * 3.2 + 200;
    const far = Math.max(3000 * this.SC, this.orbit.dist * 4);
    if (Math.abs(this.camera.far - far) > far * .1) { this.camera.far = far; this.camera.updateProjectionMatrix(); }
    this._updateLOD();
    this._updateDetail();
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(tt => this._loop(tt));
  }
}
