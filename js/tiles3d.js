// 3D terrain for the other detailed countries (Malaysia, Singapore, Brunei, Hong Kong, Macau, …):
// their 550 m tiles become block columns at real elevation, split into chunks with the same
// levels of detail as Thailand's (view3d.js), coloured from the 2D tile canvas when far away and
// drawn with Minetest block textures close up. Tiles stream in as the camera needs them.
import { paintTile, SURF } from './backdrop.js';
import { h2 } from './noise.js';
import { spriteFromRows } from './sprites.js';

const CH = 80;                                     // blocks per chunk side (5 × 5 chunks per 400-block tile)
const LODS = [1, 2, 4, 8];
const TEXTURED_LOD = 2;                            // this level of detail or finer uses block textures
const BUDGET_MS = 8;                               // chunk building time per frame
const MIN_Y = -16;                                 // bottom of the world slab (as in view3d.js)
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const SHADE = { ns: .8, ew: .62 };
const DIRT = [134, 96, 67], LOG = [102, 76, 44];
const SIDE = { grass: ['grass_side', 'dirt'], river_water: ['dirt', 'dirt'], dry_dirt: ['dirt', 'dirt'],
  jungleleaves: ['jungleleaves', 'tree'] };

export class TileTerrain {
  /**
   * @param {object} view       the View3D (three.js, scene, camera, materials, Thai height field)
   * @param {TileLayer} tiles   the 2D tile layer (loading, decoding and painting of tiles)
   * @param {Countries} countries  detailed countries; each lists the tiles it covers
   */
  constructor(view, tiles, countries) {
    this.v = view; this.tiles = tiles; this.countries = countries;
    const I = tiles.index, m = view.atlas.map;
    this.n = I.size;
    this.OX = Math.round((m.lon0 - I.lon0) / I.S);  // Thailand's grid origin in global tile blocks
    this.OY = Math.round((I.lat1 - m.lat1) / I.S);
    this.keys = new Set(countries.list.flatMap(c => c.tiles || []));
    this.held = new Map();                          // key -> prepared tile
    this.chunks = [];
    this.sel = { area: null, layer: null, focus: -1 };
    this._buildIcons();
  }

  /** Is this lon/lat inside a tile drawn here? (The ASEAN backdrop leaves a hole there.) */
  covers(lon, lat) {
    const I = this.tiles.index;
    return this.keys.has(`${Math.floor((lon - I.lon0) / I.deg)}_${Math.floor((I.lat1 - lat) / I.deg)}`);
  }

  /* ---------------- height field ---------------- */
  _h(e, sea) {
    return sea ? -Math.max(1, Math.round(Math.sqrt(Math.max(-e, 1)) / 5)) : Math.max(1, Math.round(e / this.v.metresPerBlock));
  }

  /** Full-detail column height at global tile block (gr, gc): Thailand's inside its window, MIN_Y where nothing is drawn. */
  full(gr, gc) {
    const V = this.v, r = gr - this.OY, c = gc - this.OX;
    if (r >= 0 && c >= 0 && r < V.H && c < V.W) return V.hb[r * V.W + c];
    const tt = this.held.get(`${Math.floor(gc / this.n)}_${Math.floor(gr / this.n)}`);
    return tt ? tt.hb[(gr - tt.gr0) * this.n + (gc - tt.gc0)] : MIN_Y;
  }

  /** Column height under a scene point, or null outside the tiles drawn here. */
  heightAt(x, z) {
    const gc = Math.floor(x + this.v.W / 2) + this.OX, gr = Math.floor(z + this.v.H / 2) + this.OY;
    const tt = this.held.get(`${Math.floor(gc / this.n)}_${Math.floor(gr / this.n)}`);
    return tt ? tt.hb[(gr - tt.gr0) * this.n + (gc - tt.gc0)] : null;
  }

  _add(key, t) {
    const { T } = this.v, n = this.n;
    const [tx, ty] = key.split('_').map(Number);
    const tt = { key, t, tx, ty, gr0: ty * n, gc0: tx * n };
    const tex = tt.tex = new T.CanvasTexture(t.canvas);
    tex.magFilter = T.NearestFilter;
    tex.minFilter = T.LinearMipmapLinearFilter;
    tex.anisotropy = this.v.renderer.capabilities.getMaxAnisotropy();
    tt.mat = new T.MeshBasicMaterial({ map: tex, vertexColors: true, side: T.DoubleSide });
    tt.px = t.canvas.getContext('2d').getImageData(0, 0, n, n).data;
    this.held.set(key, tt);
    this._prepare(tt);
    for (let j = 0; j < n / CH; j++) for (let i = 0; i < n / CH; i++) {
      this.chunks.push({ tt, i, j, meshes: {}, shown: 0,
        cx: tt.gc0 + (i + .5) * CH - this.OX - this.v.W / 2, cz: tt.gr0 + (j + .5) * CH - this.OY - this.v.H / 2 });
    }
    this._placeIcons();
  }

  /** Heights for every block, a down-sampled grid per level of detail, and which blocks Thailand's grid already draws. */
  _prepare(tt) {
    const V = this.v, n = this.n, t = tt.t;
    const hb = tt.hb = new Int16Array(n * n), skip = tt.skip = new Uint8Array(n * n);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      const i = r * n + c, R = tt.gr0 + r - this.OY, C = tt.gc0 + c - this.OX;
      hb[i] = this._h(t.elev[i], t.country[i] === 0);
      if (R >= 0 && C >= 0 && R < V.H && C < V.W) skip[i] = 1;
    }
    tt.lod = {};
    for (const L of LODS) {
      const w = n / L, height = new Int16Array(w * w), rep = new Int32Array(w * w);
      for (let r = 0; r < w; r++) for (let c = 0; c < w; c++) {
        let sum = 0;
        for (let y = r * L; y < r * L + L; y++) for (let x = c * L; x < c * L + L; x++) sum += hb[y * n + x];
        const k = (r * L + (L >> 1)) * n + c * L + (L >> 1);
        const v = Math.round(sum / (L * L));
        height[r * w + c] = t.country[k] === 0 ? Math.min(v, -1) : Math.max(v, 1);
        rep[r * w + c] = k;
      }
      tt.lod[L] = { L, w, height, rep };
    }
  }

  /* ---------------- chunk meshes ---------------- */
  _texName(t, k, h) {
    const Ly = this.v.layers;
    if (t.country[k] === 0) return h > -3 ? 'sand' : 'gravel';
    const w = t.water?.[k], rd = t.road?.[k];
    if (w >= 2 ? Ly.rivers : w === 1 && Ly.streams) return 'river_water';
    if (rd === 5 && Ly.rails) return 'gravel';
    if (rd === 4 && Ly.mainRoads) return 'stone';
    if ((rd === 2 || rd === 3) && Ly.mediumRoads) return 'dry_dirt';
    const s = t.surf[k];
    return s === SURF.STONE ? 'stone' : s === SURF.SAND ? 'sand' : s === SURF.TREE ? 'jungleleaves' : 'grass';
  }

  /** One chunk at one level of detail: canvas-coloured (far) or block-textured (near). */
  _build(ch, L) {
    const V = this.v, T = V.T, n = this.n, tt = ch.tt, t = tt.t, G = tt.lod[L], per = CH / L;
    const textured = V.texMat && L <= TEXTURED_LOD;
    const c0 = ch.i * per, r0 = ch.j * per, c1 = c0 + per, r1 = r0 + per;
    const ht = (r, c) => G.height[r * G.w + c], rep = (r, c) => G.rep[r * G.w + c];
    const skipped = (r, c) => tt.skip[rep(r, c)];
    const X = c => tt.gc0 + c * L - this.OX - V.W / 2, Z = r => tt.gr0 + r * L - this.OY - V.H / 2;
    // wall neighbour: same level inside the chunk; across its edge (or into Thailand's grid) the
    // lowest full-detail block along that edge, so neighbours at another level never leave a gap
    const neighbour = (r, c, dr, dc) => {
      const rr = r + dr, cc = c + dc;
      const inTile = rr >= 0 && cc >= 0 && rr < G.w && cc < G.w && !skipped(rr, cc);
      if (inTile && rr >= r0 && rr < r1 && cc >= c0 && cc < c1) return ht(rr, cc);
      let m = Infinity;
      const gR = tt.gr0 + r * L, gC = tt.gc0 + c * L;
      if (dr) { const y = dr < 0 ? gR - 1 : gR + L; for (let x = gC; x < gC + L; x++) m = Math.min(m, this.full(y, x)); }
      else { const x = dc < 0 ? gC - 1 : gC + L; for (let y = gR; y < gR + L; y++) m = Math.min(m, this.full(y, x)); }
      return inTile ? Math.min(m, ht(rr, cc)) : m;
    };
    const key = k => t.country[k] * 65536 + (t.district ? t.district[k] : 0);
    const names = [], tileIx = new Int16Array(per * per);
    if (textured) for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) {
      const nm = this._texName(t, rep(r, c), ht(r, c));
      let i = names.indexOf(nm);
      if (i < 0) { i = names.length; names.push(nm); }
      tileIx[(r - r0) * per + (c - c0)] = i;
    }
    const tex = (r, c) => tileIx[(r - r0) * per + (c - c0)];
    const same = (r0_, c0_, r1_, c1_) => {
      const a = rep(r0_, c0_), b = rep(r1_, c1_);
      return ht(r0_, c0_) === ht(r1_, c1_) && key(a) === key(b) && skipped(r0_, c0_) === skipped(r1_, c1_) &&
        (!textured || tex(r0_, c0_) === tex(r1_, c1_));
    };
    const rgb = k => [tt.px[k * 4], tt.px[k * 4 + 1], tt.px[k * 4 + 2]];
    const detailed = v => !!this.countries.byTile.get(v);

    // quad buffers: [canvas-textured tops, vertex-coloured sides] or [block-textured]
    const bufs = textured ? [{ pos: [], clr: [], uv: [], tile: [] }] : [{ pos: [], clr: [], uv: [] }, { pos: [], clr: [] }];
    const tops = [];                                        // [buffer, quad, rep block] of land tops, for highlights
    const quad = (m, v, col, f, uv, tileName) => {
      const b = bufs[m], q = b.pos.length / 12;
      b.pos.push(...v);
      for (let i = 0; i < 4; i++) b.clr.push(col[0] * f / 255, col[1] * f / 255, col[2] * f / 255);
      if (uv) b.uv.push(...uv);
      if (tileName) { const [tu, tv] = V.blocks.origin(V.blocks.tile(tileName)); for (let i = 0; i < 4; i++) b.tile.push(tu, tv); }
      return q;
    };
    const WHITE = [255, 255, 255];
    const tint = k => {
      const j = (.94 + h2(k, tt.tx * 7 + tt.ty, 17) * .1) * (detailed(t.country[k]) ? 1 : .82) * 255;
      return t.surf[k] === SURF.PADDY ? [1.02 * j, 1.1 * j, .9 * j] : [j, j, j];
    };
    const wall = (r, c, hn, f, verts, len) => {
      const k = rep(r, c), h = ht(r, c);
      if (textured) {
        const top = names[tex(r, c)], [upper, lower] = SIDE[top] || [top, top], col = tint(k);
        if (h - hn > 1) {
          quad(0, verts(h - 1, h), col, f, [0, 0, 0, 1, len, 1, len, 0], upper);
          quad(0, verts(hn, h - 1), col, f, [0, 0, 0, h - 1 - hn, len, h - 1 - hn, len, 0], lower);
        } else quad(0, verts(hn, h), col, f, [0, 0, 0, h - hn, len, h - hn, len, 0], upper);
        return;
      }
      const s = t.surf[k], sea = t.country[k] === 0, jit = .95 + h2(k, tt.tx, 17) * .1;
      const grassy = s === SURF.GRASS || s === SURF.PADDY, leafy = s === SURF.TREE;
      const side = sea ? [150, 140, 110] : grassy ? DIRT : rgb(k);
      if (!sea && (grassy || leafy) && h - hn >= 1) {
        const lip = leafy ? .6 : .2;
        quad(1, verts(h - lip, h), rgb(k), f * jit);
        quad(1, verts(hn, h - lip), leafy ? LOG : side, f * jit);
      } else quad(1, verts(hn, h), side, f * jit);
    };

    for (let r = r0; r < r1; r++) {
      const z0 = Z(r), z1 = Z(r + 1);
      for (let c = c0; c < c1;) {                          // tops, merged along the row
        let e = c + 1;
        while (e < c1 && same(r, e, r, c)) e++;
        if (!skipped(r, c)) {
          const k = rep(r, c), h = ht(r, c), x0 = X(c), x1 = X(e), sea = t.country[k] === 0;
          const v = [x0, h, z0, x0, h, z1, x1, h, z1, x1, h, z0];
          if (textured) {
            const q = quad(0, v, tint(k), 1, [0, 0, 0, z1 - z0, x1 - x0, z1 - z0, x1 - x0, 0], names[tex(r, c)]);
            if (!sea) tops.push([0, q, k]);
          } else if (sea) quad(1, v, h > -3 ? [196, 182, 132] : [128, 124, 118], 1);
          else {
            const u0 = c * L / n, u1 = e * L / n, v0 = 1 - r * L / n, v1 = 1 - (r + 1) * L / n;
            tops.push([0, quad(0, v, WHITE, 1, [u0, v0, u0, v1, u1, v1, u1, v0]), k]);
          }
        }
        c = e;
      }
      for (const dr of [-1, 1]) {                          // north / south walls
        const z = dr < 0 ? z0 : z1;
        for (let c = c0; c < c1;) {
          const hn = neighbour(r, c, dr, 0);
          let e = c + 1;
          while (e < c1 && same(r, e, r, c) && neighbour(r, e, dr, 0) === hn) e++;
          if (!skipped(r, c) && hn < ht(r, c)) {
            const xa = X(c), xb = X(e);
            wall(r, c, hn, SHADE.ns, dr < 0
              ? (lo, hi) => [xb, lo, z, xb, hi, z, xa, hi, z, xa, lo, z]
              : (lo, hi) => [xa, lo, z, xa, hi, z, xb, hi, z, xb, lo, z], xb - xa);
          }
          c = e;
        }
      }
    }
    for (let c = c0; c < c1; c++) {                          // west / east walls, merged down the column
      for (const dc of [-1, 1]) {
        const x = dc < 0 ? X(c) : X(c + 1);
        for (let r = r0; r < r1;) {
          const hn = neighbour(r, c, 0, dc);
          let e = r + 1;
          while (e < r1 && same(e, c, r, c) && neighbour(e, c, 0, dc) === hn) e++;
          if (!skipped(r, c) && hn < ht(r, c)) {
            const za = Z(r), zb = Z(e);
            wall(r, c, hn, SHADE.ew, dc < 0
              ? (lo, hi) => [x, lo, za, x, hi, za, x, hi, zb, x, lo, zb]
              : (lo, hi) => [x, lo, zb, x, hi, zb, x, hi, za, x, lo, za], zb - za);
          }
          r = e;
        }
      }
    }

    const group = new T.Group(), geos = [];
    bufs.forEach((b, m) => {
      const nq = b.pos.length / 12;
      if (!nq) { b.attr = null; return; }
      const idx = new Uint32Array(nq * 6);
      for (let q = 0; q < nq; q++) {
        const v = q * 4, o = q * 6;
        idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2; idx[o + 3] = v; idx[o + 4] = v + 2; idx[o + 5] = v + 3;
      }
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(new Float32Array(b.pos), 3));
      b.clr = new Float32Array(b.clr);
      b.attr = new T.BufferAttribute(b.clr, 3);
      if (textured) {
        geo.setAttribute('uv', new T.BufferAttribute(new Float32Array(b.uv), 2));
        geo.setAttribute('tile', new T.BufferAttribute(new Float32Array(b.tile), 2));
        geo.setAttribute('tint', b.attr);
      } else {
        geo.setAttribute('color', b.attr);
        if (m === 0) geo.setAttribute('uv', new T.BufferAttribute(new Float32Array(b.uv), 2));
      }
      geo.setIndex(new T.BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      geos.push(geo);
      group.add(new T.Mesh(geo, textured ? V.texMat : m === 0 ? tt.mat : V.sideMat));
    });
    return { L, group, geos, bufs, base: bufs.map(b => b.attr ? b.clr.slice() : null), tops, tile: t, hl: '' };
  }

  _dispose(m) {
    this.v.scene.remove(m.group);
    for (const g of m.geos) g.dispose();
  }

  _show(ch, L) {
    if (!ch.meshes[L]) {
      ch.meshes[L] = this._build(ch, L);
      this.v.scene.add(ch.meshes[L].group);
    }
    for (const [lv, m] of Object.entries(ch.meshes)) if (m) m.group.visible = +lv === L;
    ch.shown = L;
    this._highlight(ch.meshes[L]);
  }

  /** Per frame: pick up tiles that finished loading, choose each chunk's level, build within a time budget. */
  update(time) {
    for (const key of this.keys) {
      if (this.held.has(key)) continue;
      const [tx, ty] = key.split('_').map(Number);
      const t = this.tiles.get(tx, ty);
      if (t) this._add(key, t);
    }
    const V = this.v, p = V.camera.position, want = [];
    for (const ch of this.chunks) {
      const d = Math.hypot(ch.cx - p.x, ch.cz - p.z, p.y * .6);
      const L = d < V.lodDist[0] ? 1 : d < V.lodDist[1] ? 2 : d < V.lodDist[2] ? 4 : 8;
      ch.dist = d;
      if (ch.shown !== L) {
        if (ch.meshes[L]) this._show(ch, L);
        else want.push([d, ch, L]);
      }
    }
    want.sort((a, b) => a[0] - b[0]);
    const t0 = performance.now();
    for (const [, ch, L] of want) {
      // always get every chunk on screen at the coarsest level, then refine within the budget
      if (performance.now() - t0 > BUDGET_MS && (ch.shown || L !== 8)) continue;
      this._show(ch, L);
    }
    for (const ch of this.chunks) {                        // free detailed meshes that are now far away
      for (const [i, L] of [1, 2, 4].entries()) {
        const m = ch.meshes[L];
        if (m && ch.shown !== L && ch.dist > V.lodDist[i] * 1.6) { this._dispose(m); ch.meshes[L] = null; }
      }
    }
    for (const s of this.icons) s.position.y = s.userData.base + (REDUCED ? 0 : Math.sin(time / 520 + s.userData.a.id * 2.3) * .35 * V.SC);
  }

  /** Throw away meshes (all, or only the block-textured ones) so they rebuild on demand. */
  _reset(onlyTextured) {
    for (const ch of this.chunks) for (const L of LODS) {
      const m = ch.meshes[L];
      if (!m || (onlyTextured && L > TEXTURED_LOD)) continue;
      this._dispose(m); ch.meshes[L] = null;
      if (ch.shown === L) ch.shown = 0;
    }
  }

  /** Map layers changed: repaint the tile canvases (our colours) and rebuild textured chunks. */
  setLayers(layers) {
    for (const tt of this.held.values()) {
      paintTile(tt.t, this.tiles.index, layers, this.countries);
      tt.tex.needsUpdate = true;
      tt.px = tt.t.canvas.getContext('2d').getImageData(0, 0, this.n, this.n).data;
    }
    this._reset(true);
  }

  setVerticalScale() {
    for (const tt of this.held.values()) this._prepare(tt);
    this._reset(false);
    this._placeIcons();
  }

  /* ---------------- selection ---------------- */
  /** Highlight a state / region ({area, layer: its district layer, focus: district index}) or nothing. */
  setSelected(sel) {
    this.sel = { area: null, layer: null, focus: -1, ...sel };
    for (const ch of this.chunks) if (ch.meshes[ch.shown]) this._highlight(ch.meshes[ch.shown]);
    this._placeIcons();
  }

  _highlight(mesh) {
    const { area, layer, focus } = this.sel;
    const fid = layer && focus >= 0 ? layer.districts[focus]?.id : -1;
    const key = area ? `${area.country.code}:${area.id}:${fid}` : '';
    if (mesh.hl === key) return;
    mesh.bufs.forEach((b, i) => { if (b.attr) b.clr.set(mesh.base[i]); });
    if (area) {
      const cv = area.country.tileCountry, ds = area.country.districts;
      for (const [m, q, k] of mesh.tops) {
        const tile = mesh.tile;
        const d = tile.district?.[k];
        if (tile.country[k] !== cv || !d || ds[d - 1]?.area !== area.id) continue;
        const mix = d === fid ? .7 : .3, clr = mesh.bufs[m].clr, o = q * 12;
        for (let i = 0; i < 12; i += 3) {
          clr[o + i] = clr[o + i] * (1 - mix) + 1.15 * mix;
          clr[o + i + 1] = clr[o + i + 1] * (1 - mix) + 1.1 * mix;
          clr[o + i + 2] = clr[o + i + 2] * (1 - mix) + .45 * mix;
        }
      }
    }
    for (const b of mesh.bufs) if (b.attr) b.attr.needsUpdate = true;
    mesh.hl = key;
  }

  /* ---------------- item icons of the states / regions ---------------- */
  _buildIcons() {
    const V = this.v, T = V.T, m = V.atlas.map;
    this.icons = [];
    for (const c of this.countries.list) for (const a of c.areas) {
      if (!a.anchor) continue;
      const tex = new T.CanvasTexture(spriteFromRows(`c:${c.code}:${a.id}`, a.item.sprite).canvas);
      tex.magFilter = tex.minFilter = T.NearestFilter;
      const s = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, fog: false }));
      s.userData = { a, base: 0 };
      s.position.set((a.anchor[0] - m.lon0) / m.S - V.W / 2, 0, (m.lat1 - a.anchor[1]) / m.S - V.H / 2);
      V.scene.add(s);
      this.icons.push(s);
    }
    this._placeIcons();
  }

  _placeIcons() {
    const V = this.v, { area, layer } = this.sel;
    for (const s of this.icons) {
      const a = s.userData.a;
      const big = a === area;
      const z = Math.min((big ? 7 : 5) * V.SC, Math.max(2.5, Math.sqrt(a.blocks || 1) * (big ? .8 : .6)));   // small territories get small icons
      s.userData.base = Math.max(this.heightAt(s.position.x, s.position.z) ?? V._groundAt(s.position.x, s.position.z), 0) + z * .8;
      s.scale.set(z, z, 1);
      s.visible = !(big && layer?.foreign === a && V.districtIcons?.length);
    }
  }
}
