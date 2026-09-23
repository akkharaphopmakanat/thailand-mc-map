// 3D voxel view: every map block becomes a column at its real elevation.
// three.js is loaded from cdnjs the first time the 3D mode is opened.
import { B } from './config.js';
import { KIND } from './world.js';
import { h2 } from './noise.js';
import { itemSprite } from './sprites.js';

const THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
const SKY = 0x8fb8ff;
const MIN_Y = -16;                                 // bottom of the world slab
const SHADE = { top: 1, ns: .8, ew: .62 };         // Minecraft-style face brightness
const DIRT = [134, 96, 67], LOG = [102, 76, 44];
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
  return new View3D(await loadThree(), opts);
}

class View3D {
  /**
   * @param {object} THREE
   * @param {object} o  {canvas, wrap, atlas, cells, world (2D terrain, used as top texture), onHover, onClick}
   */
  constructor(THREE, { canvas, wrap, atlas, cells, world, onHover, onClick }) {
    Object.assign(this, { T: THREE, canvas, wrap, atlas, cells, world, onHover, onClick });
    const { W, H } = atlas.map;
    this.W = W; this.H = H;
    this.metresPerBlock = 60;
    this.selected = -1; this.hover = -1; this.layer = null; this.dFocus = -1;
    this.active = false; this.tween = null;
    // orbit camera around a ground target (block coordinates, centred on the map)
    this.orbit = { x: 0, z: 40, yaw: 0, pitch: .9, dist: 330 };

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 260, 900);
    this.camera = new THREE.PerspectiveCamera(50, 1, .5, 3000);

    this._buildTerrain();
    this._buildWater();
    this._buildIcons();
    this._bindInput();
    new ResizeObserver(() => this.resize()).observe(wrap);
    this.resize();
  }

  /* ---------------- terrain ---------------- */
  /** Column height in blocks for block k at the current vertical scale. */
  _height(k) {
    const e = this.cells.elev[k];
    if (this.cells.kind[k] === KIND.WATER) return -Math.max(1, Math.round(Math.sqrt(-e) / 4));
    return Math.max(1, Math.round(e / this.metresPerBlock));
  }

  _buildTerrain() {
    const { T, W, H, cells } = this;
    const { kind, col } = cells;
    const N = W * H;
    const hb = this.hb = new Int16Array(N);
    for (let k = 0; k < N; k++) hb[k] = this._height(k);
    const at = (r, c) => (r < 0 || c < 0 || r >= H || c >= W) ? MIN_Y : hb[r * W + c];

    // Two meshes: land tops textured with the 2D terrain canvas (roads, borders, grass detail),
    // and everything else (sides, seabed) in flat vertex colours.
    // Two passes each: count quads, then fill typed arrays.
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
    const pass = () => {
      count[0] = count[1] = 0;
      for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
        const k = r * W + c, h = hb[k], kd = kind[k];
        const x0 = c - W / 2, x1 = x0 + 1, z0 = r - H / 2, z1 = z0 + 1;
        const jit = .95 + h2(c, r, 17) * .1;
        const top = [col[k * 3], col[k * 3 + 1], col[k * 3 + 2]];
        const topV = [x0, h, z0, x0, h, z1, x1, h, z1, x1, h, z0];
        if (kd === KIND.WATER) {
          quad(1, topV, h > -3 ? [196, 182, 132] : [128, 124, 118], jit);   // sand shallows, gravel deeper
        } else {
          const u0 = c / W, u1 = (c + 1) / W, v0 = 1 - r / H, v1 = 1 - (r + 1) / H;
          const tq = quad(0, topV, WHITE, jit, [u0, v0, u0, v1, u1, v1, u1, v0]);
          if (buf) this._topQuad[k] = tq;
        }
        const grassy = kd === KIND.GRASS || kd === KIND.PADDY || kd === KIND.FOREIGN;
        const leafy = kd === KIND.TREE || kd === KIND.FOREIGN_TREE;
        const side = kd === KIND.WATER ? [150, 140, 110] : grassy ? DIRT : top;
        // four sides where the neighbour is lower
        const sides = [
          [at(r - 1, c), SHADE.ns, (lo, hi) => [x1, lo, z0, x1, hi, z0, x0, hi, z0, x0, lo, z0]],
          [at(r + 1, c), SHADE.ns, (lo, hi) => [x0, lo, z1, x0, hi, z1, x1, hi, z1, x1, lo, z1]],
          [at(r, c - 1), SHADE.ew, (lo, hi) => [x0, lo, z0, x0, hi, z0, x0, hi, z1, x0, lo, z1]],
          [at(r, c + 1), SHADE.ew, (lo, hi) => [x1, lo, z1, x1, hi, z1, x1, hi, z0, x1, lo, z0]],
        ];
        for (const [hn, f, v] of sides) {
          if (hn >= h) continue;
          if ((grassy || leafy) && h - hn >= 1) {
            // grass/leaf lip on top, dirt or log below
            quad(1, v(h - (leafy ? .6 : .2), h), top, f * jit);
            quad(1, v(hn, h - (leafy ? .6 : .2)), leafy ? LOG : side, f * jit);
          } else {
            quad(1, v(hn, h), side, f * jit);
          }
        }
      }
    };
    pass();
    const mk = (n, uv) => ({ n, pos: new Float32Array(n * 12), clr: new Float32Array(n * 12), uv: uv ? new Float32Array(n * 8) : null });
    buf = [mk(count[0], true), mk(count[1], false)];
    this._topQuad = new Int32Array(N).fill(-1);
    pass();
    this._tops = buf[0];
    this._baseClr = buf[0].clr.slice();

    const geometry = (b) => {
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
      return geo;
    };
    if (!this.topMat) {
      const tex = new T.CanvasTexture(this.world.canvas);
      tex.magFilter = T.NearestFilter;
      tex.minFilter = T.LinearMipmapLinearFilter;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      this.topMat = new T.MeshBasicMaterial({ map: tex, vertexColors: true, side: T.DoubleSide });
      this.sideMat = new T.MeshBasicMaterial({ vertexColors: true, side: T.DoubleSide });
    }
    for (const m of this.meshes || []) { this.scene.remove(m); m.userData.geo.dispose(); }
    this.meshes = [[buf[0], this.topMat], [buf[1], this.sideMat]].map(([b, mat]) => {
      const geo = geometry(b);
      const mesh = new T.Mesh(geo, mat);
      mesh.userData.geo = geo;
      this.scene.add(mesh);
      return mesh;
    });
    this._applyHighlight();
  }

  _buildWater() {
    const { T, W, H } = this;
    const geo = new T.PlaneGeometry(W + 400, H + 400);
    geo.rotateX(-Math.PI / 2);
    const mat = new T.MeshBasicMaterial({ color: 0x3f76e4, transparent: true, opacity: .62, depthWrite: false });
    this.water = new T.Mesh(geo, mat);
    this.water.position.y = .15;
    this.scene.add(this.water);
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
      s.userData.base = Math.max(this.hb[r * W + c], 0) + 4;
      const big = i === this.selected || i === this.hover;
      const z = big ? 7 : 5;
      s.scale.set(z, z, 1);
      s.visible = !(i === this.selected && this.districtIcons.length);
    });
    for (const s of this.districtIcons) {
      const { r, c } = s.userData;
      s.userData.base = Math.max(this.hb[r * W + c], 0) + 2.2;
      const z = s.userData.k === this.dFocus ? 3.4 : 2.4;
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
  setDistrictHover() {}

  setVerticalScale(metresPerBlock) {
    this.metresPerBlock = metresPerBlock;
    this._buildTerrain();
    this._placeIcons();
  }

  /** Tint the tops of the selected province (and focused district) yellow. */
  _applyHighlight() {
    if (!this._tops) return;
    const { W, atlas, _tops: tops, _baseClr: base, _topQuad: tq } = this;
    const clr = tops.clr;
    clr.set(base);
    const sel = this.selected;
    if (sel >= 0) {
      const b = atlas.provinces[sel].bb;
      for (let r = b[1]; r <= b[3]; r++) for (let c = b[0]; c <= b[2]; c++) {
        const k = r * W + c;
        if (atlas.grid[k] !== sel || tq[k] < 0) continue;
        let mix = .3;
        if (this.layer && this.dFocus >= 0 && this.layer.hit((c + .5) * B, (r + .5) * B) === this.dFocus) mix = .7;
        const o = tq[k] * 12;
        for (let i = 0; i < 12; i += 3) {
          clr[o + i] = clr[o + i] * (1 - mix) + 1.15 * mix;
          clr[o + i + 1] = clr[o + i + 1] * (1 - mix) + 1.1 * mix;
          clr[o + i + 2] = clr[o + i + 2] * (1 - mix) + .45 * mix;
        }
      }
    }
    tops.attr.needsUpdate = true;
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
    this._goTo({ x: (b[0] + b[2] + 1) / 2 - this.W / 2, z: (b[1] + b[3] + 1) / 2 - this.H / 2 + size * .15, dist: size * 1.9 + 30 });
  }

  focusDistrict(k) {
    const b = this.layer?.bb[k];
    if (!b || !isFinite(b[0])) return;
    const size = Math.max(b[2] - b[0], b[3] - b[1]) / B;
    this._goTo({ x: (b[0] + b[2]) / 2 / B - this.W / 2, z: (b[1] + b[3]) / 2 / B - this.H / 2, dist: size * 2.4 + 18 });
  }

  fit() { this._goTo({ x: 0, z: 40, yaw: 0, pitch: .9, dist: 330 }); }
  zoom(f) { this.tween = null; this.orbit.dist = Math.min(900, Math.max(12, this.orbit.dist / f)); }

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
  /** Ray-march the height field under a screen point. */
  pick(sx, sy) {
    const T = this.T;
    const ndc = new T.Vector2(sx / this.cw * 2 - 1, -(sy / this.ch) * 2 + 1);
    const ray = new T.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const o = ray.ray.origin, d = ray.ray.direction;
    const { W, H } = this;
    for (let t = 0; t < 2500; t += .35) {
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
        o.dist = Math.min(900, Math.max(12, pinch.dist * pinch.d / d));
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
      this.orbit.dist = Math.min(900, Math.max(12, this.orbit.dist * Math.exp(e.deltaY * (e.deltaMode === 1 ? .04 : .0012))));
    }, { passive: false });
  }

  /** Move the orbit target along the ground by a screen-space drag. */
  _pan(dx, dy) {
    const o = this.orbit;
    const k = o.dist / Math.max(this.ch, 1) * 1.1;
    const s = Math.sin(o.yaw), c = Math.cos(o.yaw);
    o.x += (-dx * c - dy * s / Math.max(Math.sin(o.pitch), .3)) * k;
    o.z += (dx * s - dy * c / Math.max(Math.sin(o.pitch), .3)) * k;
    o.x = Math.max(-this.W / 2, Math.min(this.W / 2, o.x));
    o.z = Math.max(-this.H / 2, Math.min(this.H / 2, o.z));
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
    const bob = i => reduced ? 0 : Math.sin(t / 520 + i * 1.7) * .35;
    this.icons.forEach((s, i) => { s.position.y = s.userData.base + bob(i); });
    this.districtIcons.forEach((s, i) => { s.position.y = s.userData.base + bob(i) * .6; });
    this._updateCamera();
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(tt => this._loop(tt));
  }
}
