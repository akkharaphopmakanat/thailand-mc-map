// Canvas map: camera, pan/zoom/pinch input, picking, and drawing of terrain, highlights,
// district borders, item icons and labels.
import { B, MAP_LABELS } from './config.js';
import { itemSprite } from './sprites.js';
import { railTile, maskAt, blockTexture } from './pieces.js';
import { aseanRect, countryAt } from './asean.js';

const MAX_SCALE = 24;   // screen px per world px (a 0.005° block is 1 world px)
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

export class MapView {
  /**
   * @param {object} o
   * @param {HTMLCanvasElement} o.canvas
   * @param {HTMLElement} o.wrap
   * @param {object} o.atlas   {map, grid, provinces}
   * @param {object} o.world   {canvas, paths}
   * @param {HTMLCanvasElement} [o.backdrop]  ASEAN backdrop (see asean.js)
   * @param {object} [o.cells]   block classification (world.js) for close-up textures
   * @param {(pick: object|null, e: PointerEvent) => void} o.onHover
   * @param {(pick: object) => void} o.onClick
   */
  constructor({ canvas, wrap, atlas, world, backdrop, cells, onHover, onClick }) {
    Object.assign(this, { canvas, wrap, atlas, world, backdrop, cells, onHover, onClick });
    this.blocks = null;   // block texture atlas, set once loaded (see setBlockAtlas)
    this.backRect = atlas.asean ? aseanRect(atlas.asean, atlas.map) : null;
    this.ctx = canvas.getContext('2d');
    this.view = { x: 0, y: 0, s: .3 };
    this.cw = 0; this.ch = 0; this.dpr = 1; this.fitS = .3;
    this.hover = -1; this.selected = -1;
    this.layer = null; this.dHover = -1; this.dFocus = -1;
    this.layers = { mainRoads: true, mediumRoads: true, rails: true, rivers: true, streams: false };
    this.dirty = true; this.tween = null;
    this.order = atlas.provinces.map(p => p.i).sort((a, b) => atlas.provinces[a].anchor[0] - atlas.provinces[b].anchor[0]);
    this._bindInput();
    new ResizeObserver(() => this.resize()).observe(wrap);
    this.resize();
    requestAnimationFrame(t => this._loop(t));
  }

  /* ---------------- state setters ---------------- */
  setHover(i) { if (i !== this.hover) { this.hover = i; this.dirty = true; } }
  setSelected(i) { this.selected = i; this.layer = null; this.dHover = -1; this.dFocus = -1; this.dirty = true; }
  setDistrictLayer(layer) { this.layer = layer; this.dirty = true; }
  setDistrictHover(k) { if (k !== this.dHover) { this.dHover = k; this.dirty = true; } }
  setDistrictFocus(k) { this.dFocus = k; this.dirty = true; }
  setBlockAtlas(blocks) { this.blocks = blocks; this.dirty = true; }

  /* ---------------- camera ---------------- */
  resize() {
    const r = this.wrap.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const first = !this.cw;
    this.cw = r.width; this.ch = r.height;
    this.canvas.width = Math.round(this.cw * this.dpr);
    this.canvas.height = Math.round(this.ch * this.dpr);
    const keep = this.view.s;
    const fit = this.fitView();
    if (first) Object.assign(this.view, fit);
    else this.view.s = Math.max(keep, this.fitS * .8);
    this.dirty = true;
  }

  /** Thailand in the centre, zoomed out so all of ASEAN fits vertically (or all of Thailand without the backdrop). */
  fitView() {
    const { W, H, lon0, lat1, S } = this.atlas.map;
    const k = B / S;
    const cx = (101.0 - lon0) * k, cy = (lat1 - 13.0) * k;          // centre of Thailand
    const s = this.backRect
      ? Math.min(this.ch / this.backRect[3], this.cw / (this.backRect[2] * .55)) * .98
      : Math.min(this.cw / (W * B), this.ch / (H * B)) * .96;
    this.fitS = s;
    return { s, x: this.cw / 2 - cx * s, y: this.ch / 2 - cy * s };
  }

  goTo(target) {
    if (reduced) { Object.assign(this.view, target); this.dirty = true; return; }
    this.tween = { a: { ...this.view }, b: target, t0: performance.now(), d: 520 };
  }

  zoomAt(f, sx, sy) {
    this.tween = null;
    const v = this.view;
    const ns = Math.max(this.fitS * .8, Math.min(MAX_SCALE, v.s * f));
    const k = ns / v.s;
    v.x = sx - (sx - v.x) * k; v.y = sy - (sy - v.y) * k; v.s = ns;
    this.dirty = true;
  }

  /** Fly so the world-pixel box fills about 1/pad of the view. */
  focusBox(x0, y0, x1, y1, pad, maxS) {
    let s = Math.min(this.cw / ((x1 - x0) * pad), this.ch / ((y1 - y0) * pad), maxS);
    s = Math.max(s, this.fitS * 1.6);
    this.goTo({ s, x: this.cw / 2 - (x0 + x1) / 2 * s, y: this.ch / 2 - (y0 + y1) / 2 * s });
  }

  focusProvince(i) {
    const b = this.atlas.provinces[i].bb;
    this.focusBox(b[0] * B, b[1] * B, (b[2] + 1) * B, (b[3] + 1) * B, 1.5, 3);
  }

  focusDistrict(k) {
    const b = this.layer?.bb[k];
    if (!b || !isFinite(b[0])) return;
    this.focusBox(b[0], b[1], b[2], b[3], 3, MAX_SCALE);
  }

  /* ---------------- picking ---------------- */
  /** @returns {{r:number,c:number,v:number,province:number,district:number}|null} */
  pick(sx, sy) {
    const { W, H } = this.atlas.map;
    const wx = (sx - this.view.x) / this.view.s, wy = (sy - this.view.y) / this.view.s;
    const c = Math.floor(wx / B), r = Math.floor(wy / B);
    if (c < 0 || r < 0 || c >= W || r >= H) {
      const country = this.atlas.asean ? countryAt(this.atlas.asean, this.atlas.map, wx, wy) : '';
      return country ? { r, c, v: -3, province: -1, district: -1, country } : null;
    }
    const v = this.atlas.grid[r * W + c];
    let province = v >= 0 ? v : -1, district = -1;
    if (this.layer) {
      district = this.layer.hit(wx, wy);
      // the district raster is finer than the block grid, so trust it near borders
      if (district >= 0) province = this.selected;
    }
    const country = v < 0 && this.atlas.asean ? countryAt(this.atlas.asean, this.atlas.map, wx, wy) : '';
    return { r, c, v, province, district, country };
  }

  /* ---------------- input ---------------- */
  _bindInput() {
    const cv = this.canvas, pts = new Map();
    let down = null, pinch = null;
    cv.addEventListener('pointerdown', e => {
      cv.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (pts.size === 1) { down = { x: e.offsetX, y: e.offsetY, vx: this.view.x, vy: this.view.y, moved: false }; this.tween = null; }
      else if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: this.view.s, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, vx: this.view.x, vy: this.view.y };
        if (down) down.moved = true;
      }
    });
    cv.addEventListener('pointermove', e => {
      if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (pinch && pts.size >= 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const ns = Math.max(this.fitS * .8, Math.min(MAX_SCALE, pinch.s * d / pinch.d)), k = ns / pinch.s;
        Object.assign(this.view, { s: ns, x: mx - (pinch.mx - pinch.vx) * k, y: my - (pinch.my - pinch.vy) * k });
        this.dirty = true;
        return;
      }
      if (down && pts.size === 1) {
        const dx = e.offsetX - down.x, dy = e.offsetY - down.y;
        if (Math.abs(dx) + Math.abs(dy) > 5) { down.moved = true; cv.classList.add('dragging'); }
        if (down.moved) {
          this.view.x = down.vx + dx; this.view.y = down.vy + dy; this.dirty = true;
          this.onHover(null, e);
          return;
        }
      }
      const pk = this.pick(e.offsetX, e.offsetY);
      this.setHover(pk ? pk.province : -1);
      this.setDistrictHover(pk ? pk.district : -1);
      cv.classList.toggle('over', !!pk && pk.province >= 0);
      this.onHover(pk, e);
    });
    const end = e => {
      const wasClick = down && !down.moved && pts.size === 1;
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 0) {
        cv.classList.remove('dragging');
        if (wasClick && e.type === 'pointerup') {
          const pk = this.pick(e.offsetX, e.offsetY);
          if (pk && pk.province >= 0) this.onClick(pk);
        }
        down = null;
      } else if (pts.size === 1) {
        const [p] = [...pts.values()];
        down = { x: p.x, y: p.y, vx: this.view.x, vy: this.view.y, moved: true };
      }
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', e => {
      if (e.pointerType !== 'mouse') return;
      this.setHover(-1); this.setDistrictHover(-1);
      this.onHover(null, e);
    });
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      this.zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? .05 : .0016)), e.offsetX, e.offsetY);
    }, { passive: false });
  }

  /* ---------------- drawing ---------------- */
  _loop(t) {
    const tw = this.tween;
    if (tw) {
      const k = Math.min(1, (t - tw.t0) / tw.d), e = 1 - Math.pow(1 - k, 3);
      for (const key of ['s', 'x', 'y']) this.view[key] = tw.a[key] + (tw.b[key] - tw.a[key]) * e;
      if (k >= 1) this.tween = null;
      this.dirty = true;
    }
    if (this.dirty || !reduced) { this._draw(t); this.dirty = false; }
    requestAnimationFrame(tt => this._loop(tt));
  }

  /**
   * Draw each on-screen Thai-grid block with its block texture, then the terrain map on top at
   * low opacity so province shading, relief and borders still read.
   */
  _drawTextures(blockPx) {
    const { ctx, view, atlas, cw, ch, blocks, cells, world } = this;
    const { W, H } = atlas.map;
    const c0 = Math.max(0, Math.floor(-view.x / blockPx)), c1 = Math.min(W - 1, Math.ceil((cw - view.x) / blockPx));
    const r0 = Math.max(0, Math.floor(-view.y / blockPx)), r1 = Math.min(H - 1, Math.ceil((ch - view.y) / blockPx));
    const z = Math.ceil(blockPx) + 1;
    ctx.imageSmoothingEnabled = false;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const k = r * W + c;
      if (atlas.grid[k] === -1 && cells.kind[k] === 1 && cells.elev[k] < -25) continue;   // open sea: keep the map colour
      const [u, v] = blocks.origin(blocks.tile(blockTexture(k, atlas, cells, this.layers)));
      const cvw = blocks.canvas.width, cvh = blocks.canvas.height;
      ctx.drawImage(blocks.canvas, u * cvw, (1 - v) * cvh - 16, 16, 16,
        Math.floor(view.x + c * blockPx), Math.floor(view.y + r * blockPx), z, z);
    }
    ctx.globalAlpha = .3;
    ctx.drawImage(world.canvas, view.x, view.y, W * B * view.s, H * B * view.s);
    ctx.globalAlpha = 1;
  }

  /** Draw connected rail pieces for the railway blocks on screen (roads stay plain blocks). */
  _drawBlockDetail(blockPx) {
    const { ctx, view, atlas, cw, ch } = this;
    const { W, H } = atlas.map;
    const roads = atlas.roads;
    if (!roads || !this.layers.rails) return;
    const c0 = Math.max(0, Math.floor(-view.x / blockPx)), c1 = Math.min(W - 1, Math.ceil((cw - view.x) / blockPx));
    const r0 = Math.max(0, Math.floor(-view.y / blockPx)), r1 = Math.min(H - 1, Math.ceil((ch - view.y) / blockPx));
    const isRail = (r, c) => r >= 0 && c >= 0 && r < H && c < W && roads[r * W + c] === 5;
    ctx.imageSmoothingEnabled = false;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      if (roads[r * W + c] !== 5) continue;
      const x = Math.floor(view.x + c * blockPx), y = Math.floor(view.y + r * blockPx), z = Math.ceil(blockPx) + 1;
      ctx.drawImage(railTile(maskAt(r, c, isRail)), x, y, z, z);
    }
  }

  _w2s(wx, wy) { return [wx * this.view.s + this.view.x, wy * this.view.s + this.view.y]; }

  _text(txt, x, y, color, shadow = '#3f3f3f') {
    const ctx = this.ctx;
    ctx.fillStyle = shadow; ctx.fillText(txt, x + 1.5, y + 1.5);
    ctx.fillStyle = color; ctx.fillText(txt, x, y);
  }

  _draw(t) {
    const { ctx, dpr, view, cw, ch, atlas, world } = this;
    const { map, provinces } = atlas;
    const s = view.s;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#28409a';
    ctx.fillRect(0, 0, cw, ch);
    if (this.backdrop) {                                  // all ASEAN, lower detail
      const [bx, by, bw, bh] = this.backRect;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.backdrop, view.x + bx * s, view.y + by * s, bw * s, bh * s);
    }
    ctx.imageSmoothingEnabled = s < 1;
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(world.canvas, view.x, view.y, map.W * B * s, map.H * B * s);

    // Close up: block textures, then connected Minecraft rail pieces
    const blockPx = s * B;
    if (blockPx >= 12 && this.blocks) this._drawTextures(blockPx);
    if (blockPx >= 8) this._drawBlockDetail(blockPx);

    // Province + district highlights, in world coordinates
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * view.x, dpr * view.y);
    const sel = this.selected, hov = this.hover, P = world.paths, L = this.layer;
    if (sel >= 0) { ctx.fillStyle = 'rgba(255,255,160,.14)'; ctx.fill(P[sel].fill); }
    if (hov >= 0 && hov !== sel) {
      ctx.fillStyle = 'rgba(255,255,255,.14)'; ctx.fill(P[hov].fill);
      ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 2 / s; ctx.stroke(P[hov].edge);
    }
    if (L) {
      ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 1.2 / s; ctx.stroke(L.inner);
      if (this.dHover >= 0 && this.dHover !== this.dFocus) { ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.fill(L.fills[this.dHover]); }
      if (this.dFocus >= 0) {
        ctx.fillStyle = 'rgba(255,255,85,.28)'; ctx.fill(L.fills[this.dFocus]);
        ctx.strokeStyle = '#000'; ctx.lineWidth = 4 / s; ctx.stroke(L.edges[this.dFocus]);
        ctx.strokeStyle = '#ffff55'; ctx.lineWidth = 2 / s; ctx.stroke(L.edges[this.dFocus]);
      }
    }
    if (sel >= 0) {
      ctx.strokeStyle = '#000'; ctx.lineWidth = 5 / s; ctx.stroke(P[sel].edge);
      ctx.strokeStyle = '#ffff55'; ctx.lineWidth = 2.5 / s; ctx.stroke(P[sel].edge);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

    // River names along the river once zoomed in
    if (atlas.rivers?.labels && this.layers.rivers && s >= .9) {
      ctx.font = 'italic 600 12px "Pixelify Sans", monospace';
      for (const [name, lx, ly, angle] of atlas.rivers.labels) {
        const [sx, sy] = this._w2s(lx, ly);
        if (sx < -80 || sy < -20 || sx > cw + 80 || sy > ch + 20) continue;
        const r = { name };
        let a = -angle * Math.PI / 180;
        if (a > Math.PI / 2) a -= Math.PI; else if (a < -Math.PI / 2) a += Math.PI;
        ctx.save(); ctx.translate(sx, sy - 8); ctx.rotate(a);
        this._text(r.name, 0, 0, '#bfe0ff', 'rgba(10,30,80,.8)');
        ctx.restore();
      }
    }

    // Seas and ASEAN countries
    ctx.font = '600 13px "Pixelify Sans", monospace';
    for (const [txt, lat, lon] of MAP_LABELS) {
      const [sx, sy] = this._w2s((lon - map.lon0) / map.S * B, (map.lat1 - lat) / map.S * B);
      this._text(txt, sx, sy, 'rgba(235,240,255,.72)', 'rgba(0,0,0,.45)');
    }
    const A = atlas.asean;
    if (A) {
      ctx.font = '600 15px "Pixelify Sans", monospace';
      for (const c of A.countries) {
        if (c.code === 'THA' || !c.anchor) continue;
        const lon = A.lon0 + (c.anchor[1] + .5) * A.S, lat = A.lat1 - (c.anchor[0] + .5) * A.S;
        const [sx, sy] = this._w2s((lon - map.lon0) / map.S * B, (map.lat1 - lat) / map.S * B);
        this._text(c.name.toUpperCase(), sx, sy, 'rgba(255,255,255,.85)', 'rgba(0,0,0,.6)');
      }
    }

    // District items and names when there is room
    let districtIcons = false;
    if (L) {
      const cellPx = L.k * s;
      ctx.font = '600 11px "Pixelify Sans", monospace';
      L.districts.forEach((d, i) => {
        const a = L.anchor(i);
        if (!a) return;
        const area = d.cells * cellPx * cellPx;
        const sz = Math.round(Math.min(34, Math.sqrt(area) * .42));
        const [sx, sy] = this._w2s(a[0], a[1]);
        if (sx < -40 || sy < -40 || sx > cw + 40 || sy > ch + 40) return;
        const focus = i === this.dFocus || i === this.dHover;
        if (sz >= 12 || focus) {
          districtIcons = true;
          const z = Math.max(sz, 18) * (focus ? 1.3 : 1);
          ctx.fillStyle = 'rgba(0,0,0,.3)';
          ctx.beginPath(); ctx.ellipse(sx, sy + z * .42, z * .32, z * .09, 0, 0, Math.PI * 2); ctx.fill();
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(L.sprite(i).canvas, Math.round(sx - z / 2), Math.round(sy - z / 2 - z * .12), Math.round(z), Math.round(z));
          if (area >= 2600 || focus) this._text(d.name.en, sx, Math.round(sy + z * .5 + 7), i === this.dFocus ? '#ffff55' : '#fff');
        } else if (area >= 2600) {
          this._text(d.name.en, sx, sy, '#fff');
        }
      });
    }

    // Floating item icons
    // icon size follows screen px per 0.04°, so icons keep their size whatever the block size
    const cell = s * B * (.04 / map.S);
    const base = Math.max(11, Math.min(44, cell * 3.4));
    const zoomedOut = s < .12;                           // whole-ASEAN view: only hovered/selected items
    const showNames = cell >= 6.5;
    const drawIcon = (i, big) => {
      const p = provinces[i];
      const [sx, sy] = this._w2s((p.anchor[1] + .5) * B, (p.anchor[0] + .5) * B);
      if (sx < -60 || sy < -60 || sx > cw + 60 || sy > ch + 60) return;
      const sz = Math.round(big ? base * 1.45 : base);
      const bob = reduced ? 0 : Math.sin(t / 520 + i * 1.7) * Math.max(1, sz * .06);
      ctx.fillStyle = 'rgba(0,0,0,.32)';
      ctx.beginPath(); ctx.ellipse(sx, sy + sz * .42, sz * .34, sz * .1, 0, 0, Math.PI * 2); ctx.fill();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(itemSprite(p).canvas, Math.round(sx - sz / 2), Math.round(sy - sz / 2 - sz * .12 + bob), sz, sz);
      if (showNames || big) {
        ctx.font = `600 ${big ? 14 : 12}px "Pixelify Sans", monospace`;
        this._text(p.name.en, sx, Math.round(sy + sz * .56 + 8), big ? '#ffff55' : '#fff');
      }
    };
    if (!zoomedOut) for (const i of this.order) if (i !== hov && i !== sel) drawIcon(i, false);
    if (hov >= 0 && hov !== sel) drawIcon(hov, true);
    if (sel >= 0 && !districtIcons) drawIcon(sel, true);
  }
}
