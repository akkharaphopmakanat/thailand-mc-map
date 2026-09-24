// Everything outside Thailand's own map, in Minecraft-map style:
// - low-detail backdrops of the whole world (0.25°, ~27 km blocks) and the ASEAN region (0.05°, ~5.5 km);
//   countries marked `detail` (ASEAN, Hong Kong, Macau) in full colour, the rest dimmer;
// - detailed 550 m tiles (2° × 2°) for ASEAN, Hong Kong and Macau, streamed as the map pans and zooms;
// - the countries brought up to Thailand's level (Sprint 2 on): their states / provinces / regions
//   with iconic items, and districts, which tile blocks refer to (tile country value + district id).
import { B, BIOMES, BIOME_IDS } from './config.js';
import { h2, vn } from './noise.js';
import { decodeRows } from './rle.js';

/**
 * Decode a backdrop from map.json ('asean' or 'world') plus its elevation (metres, decoded PNG)
 * into {W, H, S, lon0, lat1, grid (0 sea, 1 + country index), elev, countries}.
 */
export function decodeBackdrop(json, elev) {
  const specials = { '.': 0 };
  json.countries.forEach((c, i) => { specials[String.fromCharCode(json.symbol_base + i)] = i + 1; });
  const grid = decodeRows(json.rows, json.W, json.H, '', specials);
  return { ...json, grid, elev };
}

/** Paint a backdrop, one pixel per block. Returns a canvas W × H. */
export function renderBackdrop(a) {
  const { W, H, grid, elev, countries } = a;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const x = cv.getContext('2d');
  const img = x.createImageData(W, H), px = img.data;
  const step = a.S >= .2 ? 300 : 120;                      // relief step (metres) for the shading
  const level = k => Math.floor(Math.max(elev ? elev[k] : 0, 0) / step);
  const coldLat = lat => Math.abs(lat) > 55;
  for (let r = 0; r < H; r++) {
    const lat = a.lat1 - (r + .5) * a.S;
    for (let c = 0; c < W; c++) {
      const k = r * W + c, v = grid[k], e = elev ? elev[k] : 0;
      let rgb;
      if (v === 0) {
        const d = Math.max(-e, 1);
        rgb = d <= 30 ? [74, 122, 226] : d <= 200 ? (((r + c) & 1) ? [62, 104, 214] : [58, 96, 206])
          : d <= 1500 ? [50, 82, 192] : (((r + c) & 1) && d <= 3000 ? [46, 74, 180] : [40, 64, 166]);
      } else {
        const coast = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dr, dc]) => grid[(r + dr) * W + c + dc] === 0);
        const polar = Math.abs(lat) > 62 + h2(c >> 1, r >> 1, 11) * 8;          // ragged snow line, not a band
        rgb = e > 4500 || coldLat(lat) && e > 800 || polar ? [236, 240, 244]
          : e > 2200 ? [132, 132, 134] : coast && e < 30 ? [222, 208, 160]
          : e > 900 ? [70, 112, 50] : Math.abs(lat) < 25 ? [92, 142, 60] : [110, 150, 70];
        const detail = countries[v - 1]?.detail;
        const g = (rgb[0] + rgb[1] + rgb[2]) / 3;
        if (!detail) rgb = rgb.map(q => (q * .7 + g * .3) * .62);          // outside ASEAN / HK / Macau
        else if (countries[v - 1].code !== 'THA') rgb = rgb.map(q => (q * .7 + g * .3) * .9);
        // Minecraft map relief: brighter when higher than the block to the north
        if (r > 0 && grid[k - W] !== 0) { const l = level(k), n = level(k - W); rgb = rgb.map(q => q * (l > n ? 1.12 : l < n ? .84 : 1)); }
        const nb = [grid[k - 1], grid[k + 1], grid[k - W], grid[k + W]];
        if (nb.some(u => u > 0 && u !== v)) rgb = rgb.map(q => q * .55);     // country borders
      }
      const n = .94 + h2(c, r, 7) * .12, o = k * 4;
      px[o] = Math.min(255, rgb[0] * n); px[o + 1] = Math.min(255, rgb[1] * n); px[o + 2] = Math.min(255, rgb[2] * n); px[o + 3] = 255;
    }
  }
  x.putImageData(img, 0, 0);
  return cv;
}

/** Where a backdrop sits in the detailed map's world pixels: [x, y, width, height]. */
export function backdropRect(a, map) {
  const k = B / map.S;                                  // world px per degree
  return [(a.lon0 - map.lon0) * k, (map.lat1 - a.lat1) * k, a.W * a.S * k, a.H * a.S * k];
}

/** Country under a world-pixel point, or null. */
export function countryAt(a, map, wx, wy) {
  const [x0, y0, w, h] = backdropRect(a, map);
  const c = Math.floor((wx - x0) / w * a.W), r = Math.floor((wy - y0) / h * a.H);
  if (c < 0 || r < 0 || c >= a.W || r >= a.H) return null;
  const v = a.grid[r * a.W + c];
  return v ? a.countries[v - 1] : null;
}

/** World-pixel position of a country's label point. */
export function labelPoint(a, map, country) {
  const lon = a.lon0 + (country.anchor[1] + .5) * a.S, lat = a.lat1 - (country.anchor[0] + .5) * a.S;
  return [(lon - map.lon0) / map.S * B, (map.lat1 - lat) / map.S * B];
}

/* ---------------- detailed 550 m tiles ---------------- */
const CACHE = 48;                                         // decoded tiles kept in memory

export class TileLayer {
  /**
   * @param {object} map        data/map.json (for the world-pixel frame)
   * @param {Countries} [countries]  countries with districts, roads… in the tiles (Countries, below)
   */
  constructor(map, countries = null) {
    this.map = map;
    this.countries = countries;
    this.layers = { mainRoads: true, mediumRoads: true, rails: true, rivers: true, streams: false };
    this.selected = null;           // {country, area} to highlight
    this.index = null;
    this.cache = new Map();                               // key -> {canvas, elev, country}
    this.loading = new Set();
    this.onLoad = () => {};
  }

  async init() {
    try {
      const res = await fetch('data/tiles/index.json');
      if (!res.ok) return;
      this.index = await res.json();
      this.present = new Set(this.index.tiles.map(([x, y]) => `${x}_${y}`));
    } catch { this.index = null; }
  }

  /** World-pixel rectangle of tile (tx, ty): [x, y, w, h]. */
  rect(tx, ty) {
    const I = this.index, m = this.map, k = B / m.S;
    return [(I.lon0 + tx * I.deg - m.lon0) * k, (m.lat1 - (I.lat1 - ty * I.deg)) * k, I.deg * k, I.deg * k];
  }

  /** Tiles overlapping a world-pixel rectangle. */
  visible(x0, y0, x1, y1) {
    if (!this.index) return [];
    const I = this.index, k = B / this.map.S, size = I.deg * k;
    const ox = (I.lon0 - this.map.lon0) * k, oy = (this.map.lat1 - I.lat1) * k;
    const out = [];
    for (let ty = Math.max(0, Math.floor((y0 - oy) / size)); ty <= Math.min(I.rows - 1, Math.floor((y1 - oy) / size)); ty++) {
      for (let tx = Math.max(0, Math.floor((x0 - ox) / size)); tx <= Math.min(I.cols - 1, Math.floor((x1 - ox) / size)); tx++) {
        if (this.present.has(`${tx}_${ty}`)) out.push([tx, ty]);
      }
    }
    return out;
  }

  /** Decoded tile or null (and start loading it). */
  get(tx, ty) {
    const key = `${tx}_${ty}`;
    const t = this.cache.get(key);
    if (t) { this.cache.delete(key); this.cache.set(key, t); return t; }   // keep recently used last
    if (!this.loading.has(key)) this._load(tx, ty, key);
    return null;
  }

  async _load(tx, ty, key) {
    this.loading.add(key);
    try {
      const [px, lay] = await Promise.all([pixels(`data/tiles/${key}.png`), pixels(`data/tiles/${key}.a.png`).catch(() => null)]);
      const n = Math.round(Math.sqrt(px.length / 4));
      const elev = new Int16Array(n * n), country = new Uint8Array(n * n);
      for (let i = 0; i < n * n; i++) { elev[i] = px[i * 4] * 256 + px[i * 4 + 1] - 32768; country[i] = px[i * 4 + 2]; }
      // optional layers: district (R * 256 + G), road | water << 3 (B)
      let district = null, road = null, water = null;
      if (lay) {
        district = new Uint16Array(n * n); road = new Uint8Array(n * n); water = new Uint8Array(n * n);
        for (let i = 0; i < n * n; i++) { district[i] = lay[i * 4] * 256 + lay[i * 4 + 1]; road[i] = lay[i * 4 + 2] & 7; water[i] = lay[i * 4 + 2] >> 3; }
      }
      const cv = document.createElement('canvas');
      cv.width = cv.height = n;
      const tile = { tx, ty, n, elev, country, district, road, water, canvas: cv };
      paintTile(tile, this.index, this.layers, this.countries);
      this.cache.set(key, tile);
      while (this.cache.size > CACHE) this.cache.delete(this.cache.keys().next().value);
      this.onLoad();
    } catch { /* missing tile: the backdrop shows through */ }
    this.loading.delete(key);
  }

  /** Layers changed: repaint the tiles in memory. */
  setLayers(layers) {
    this.layers = { ...layers };
    for (const t of this.cache.values()) paintTile(t, this.index, this.layers, this.countries);
  }

  /** Highlight an area ({country, area}) or nothing. */
  setSelected(sel) {
    this.selected = sel;
    for (const t of this.cache.values()) t.overlay = null;
  }

  /** Yellow tint + outline over the selected area's blocks in a tile (cached), or null. */
  overlay(t) {
    const sel = this.selected;
    if (!sel || !t.district) return null;
    const key = `${sel.country.code}:${sel.area.id}`;
    if (t.overlay?.key === key) return t.overlay.canvas;
    const n = t.n, cv = document.createElement('canvas');
    cv.width = cv.height = n;
    const x = cv.getContext('2d'), img = x.createImageData(n, n), px = img.data;
    const cval = sel.country.tileCountry, dists = sel.country.districts;
    const inArea = i => t.country[i] === cval && t.district[i] && dists[t.district[i] - 1]?.area === sel.area.id;
    let any = false;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      const i = r * n + c;
      if (!inArea(i)) continue;
      any = true;
      const edge = (c > 0 && !inArea(i - 1)) || (c < n - 1 && !inArea(i + 1)) || (r > 0 && !inArea(i - n)) || (r < n - 1 && !inArea(i + n));
      const o = i * 4;
      if (edge) { px[o] = 255; px[o + 1] = 255; px[o + 2] = 85; px[o + 3] = 255; }
      else { px[o] = 255; px[o + 1] = 255; px[o + 2] = 160; px[o + 3] = 50; }
    }
    x.putImageData(img, 0, 0);
    t.overlay = { key, canvas: any ? cv : null };
    return t.overlay.canvas;
  }

  /** Country (index.json entry) and elevation at a world-pixel point, if its tile is loaded. */
  at(wx, wy) {
    if (!this.index) return null;
    const I = this.index, k = B / this.map.S, size = I.deg * k;
    const fx = (wx - (I.lon0 - this.map.lon0) * k) / size, fy = (wy - (this.map.lat1 - I.lat1) * k) / size;
    const tx = Math.floor(fx), ty = Math.floor(fy);
    const t = this.cache.get(`${tx}_${ty}`);
    if (!t) return null;
    const c = Math.floor((fx - tx) * t.n), r = Math.floor((fy - ty) * t.n), i = r * t.n + c;
    const found = t.district && this.countries ? this.countries.lookup(t.country[i], t.district[i]) : null;
    return { country: t.country[i] ? I.countries[t.country[i] - 1] : null, elevation: t.elev[i], ...(found ? { detail: found } : {}) };
  }
}

/** RGBA pixels of a PNG (no colour conversion, so values stay exact). */
async function pixels(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status);
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const cv = document.createElement('canvas');
  cv.width = bmp.width; cv.height = bmp.height;
  const x = cv.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp, 0, 0);
  return x.getImageData(0, 0, bmp.width, bmp.height).data;
}

const ROAD_RGB = { 2: [150, 122, 70], 3: [150, 122, 70], 4: [128, 128, 130] };

/** Surface of a tile block (tile.surf, filled by paintTile). */
export const SURF = { SEA: 0, GRASS: 1, TREE: 2, SAND: 3, STONE: 4, PADDY: 5 };

/** Block texture name for tile block k (as in the 3D view); h = its height, sea floor included. */
export function tileTexture(t, k, layers, h = t.elev[k]) {
  if (t.country[k] === 0) return h > -3 ? 'sand' : 'gravel';
  const w = t.water?.[k], rd = t.road?.[k];
  if (w >= 2 ? layers.rivers : w === 1 && layers.streams) return 'river_water';
  if (rd === 5 && layers.rails) return 'gravel';
  if (rd === 4 && layers.mainRoads) return 'stone';
  if ((rd === 2 || rd === 3) && layers.mediumRoads) return 'dry_dirt';
  const s = t.surf[k], bm = t.bio[k] ? BIOMES[BIOME_IDS[t.bio[k] - 1]] : null;
  return s === SURF.STONE ? 'stone' : s === SURF.SAND ? 'sand' : s === SURF.TREE ? (bm ? bm.leaves : 'jungleleaves') : (bm ? bm.grass : 'grass');
}

/**
 * Paint a decoded tile into its canvas, one pixel per 550 m block: terrain, then (where the tile
 * has layers) rivers and lakes, roads and railways, and district / area borders.
 */
export function paintTile(t, I, layers = {}, countries = null) {
  const { n, elev, country, canvas, district, road, water } = t;
  const x = canvas.getContext('2d');
  const img = x.createImageData(n, n), px = img.data;
  const level = i => Math.floor(Math.max(elev[i], 0) / 40);
  const surf = t.surf ??= new Uint8Array(n * n);          // what each block is, for the 3D view (SURF)
  const bio = t.bio ??= new Uint8Array(n * n);            // its biome (1 + BIOME_IDS index; 0 = none), for the 3D view
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const i = r * n + c, v = country[i], e = elev[i];
    const gc = t.tx * n + c, gr = t.ty * n + r;           // global block coordinates, so noise joins across tiles
    let rgb, tree = false;
    if (v === 0) {
      const d = Math.max(-e, 2);
      rgb = d <= 15 ? [74, 122, 226] : d <= 40 ? (((gr + gc) & 1) ? [62, 104, 214] : [58, 96, 206])
        : d <= 120 ? [50, 82, 192] : (((gr + gc) & 1) && d <= 600 ? [46, 74, 180] : [40, 64, 166]);
    } else {
      const coast = (r > 0 && !country[i - n]) || (r < n - 1 && !country[i + n]) || (c > 0 && !country[i - 1]) || (c < n - 1 && !country[i + 1]);
      // the biome of the block's state / region, like Thailand's regions (none outside detailed countries)
      const bm = district && countries && district[i] ? countries.byTile.get(v)?.districtBiome?.[district[i] - 1] : null;
      bio[i] = bm ? BIOME_IDS.indexOf(bm.id) + 1 : 0;
      tree = vn(gc / 24, gr / 24, 5) > (bm ? bm.forest : .46) - Math.min(Math.max(e, 0), 1500) / 3000 && h2(gc, gr, 6) < .6;
      if (coast && e < 40) { rgb = [222, 208, 160]; surf[i] = SURF.SAND; }
      else if (e > 1350 + h2(gc, gr, 7) * 250) { rgb = [132, 132, 134]; surf[i] = SURF.STONE; }
      else if (tree) { rgb = bm ? [bm.base[0] * .66, bm.base[1] * .7, bm.base[2] * .66] : [42, 96, 36]; surf[i] = SURF.TREE; }
      else if ((!bm || bm.paddy) && e < 60 && vn(gc / 20, gr / 20, 21) > .55) { rgb = [126, 186, 78]; surf[i] = SURF.PADDY; }   // paddy fields on the plains
      else { rgb = bm ? bm.base.slice() : [80, 146, 56]; surf[i] = SURF.GRASS; }
      const detail = I.countries[v - 1]?.detail;
      if (!detail) { const g = (rgb[0] + rgb[1] + rgb[2]) / 3; rgb = rgb.map(q => (q * .7 + g * .3) * .62); }
      if (r > 0 && country[i - n]) { const a = level(i) + (tree ? 1 : 0), b = level(i - n); rgb = rgb.map(q => q * (a > b ? 1.12 : a < b ? .84 : 1)); }
      if (water) {                                        // rivers and lakes
        const w = water[i];
        if (w >= 2 ? layers.rivers : w === 1 && layers.streams) rgb = [58, 104, 214];
      }
      if (road) {                                         // roads (main stone, medium dirt path) and rails
        const rd = road[i];
        const on = rd === 5 ? layers.rails : rd === 4 ? layers.mainRoads : (rd === 2 || rd === 3) && layers.mediumRoads;
        if (on) rgb = rd === 5 ? ((gc + gr) & 1 ? [176, 176, 184] : [104, 80, 52]) : ROAD_RGB[rd];
      }
      if (district && countries) {                        // district borders (thin), area borders (darker)
        const d = district[i], dr = c + 1 < n ? district[i + 1] : d, dd = r + 1 < n ? district[i + n] : d;
        if (d && ((dr && dr !== d) || (dd && dd !== d))) {
          const ds = countries.byTile.get(v)?.districts;
          const area = ds?.[d - 1]?.area, other = (dr && dr !== d ? ds?.[dr - 1]?.area : ds?.[dd - 1]?.area);
          rgb = rgb.map(q => q * (area !== other ? .5 : .78));
        }
      }
      if ((c + 1 < n && country[i + 1] && country[i + 1] !== v) || (r + 1 < n && country[i + n] && country[i + n] !== v)) rgb = rgb.map(q => q * .45);
    }
    const f = tree ? .78 + h2(gc, gr, 8) * .4 : .93 + h2(gc, gr, 3) * .14, o = i * 4;
    px[o] = Math.min(255, rgb[0] * f); px[o + 1] = Math.min(255, rgb[1] * f); px[o + 2] = Math.min(255, rgb[2] * f); px[o + 3] = 255;
  }
  x.putImageData(img, 0, 0);
}

/* ---------------- detailed countries ---------------- */
export class Countries {
  constructor(map) {
    this.map = map;
    this.list = [];                 // [{code, name, term, tileCountry, areas, districts}]
    this.byTile = new Map();        // tile country value -> country
  }

  async init() {
    try {
      const idx = await (await fetch('data/countries/index.json')).json();
      this.list = await Promise.all(idx.countries.map(async c => {
        const full = await (await fetch(`data/countries/${c.code}.json`)).json();
        full.tiles = c.tiles || [];                  // tiles it covers, for the 3D view
        for (const a of full.areas) { a.country = full; a.biome = BIOMES[a.biome] ? a.biome : 'sparse_jungle'; }
        full.districtBiome = full.districts.map(d => BIOMES[full.areas[d.area - 1].biome]);
        for (const d of full.districts) d.country = full;
        return full;
      }));
      for (const c of this.list) this.byTile.set(c.tileCountry, c);
    } catch { this.list = []; }
    return this.list;
  }

  /** Area and district for a tile block: country value (tile B channel) + district id (1-based). */
  lookup(tileCountry, districtId) {
    const c = this.byTile.get(tileCountry);
    if (!c || !districtId) return null;
    const d = c.districts[districtId - 1];
    return d ? { country: c, district: d, area: c.areas[d.area - 1] } : null;
  }

  /** World-pixel position of an area's label point. */
  anchor(area) {
    if (!area.anchor) return null;
    const m = this.map, k = B / m.S;
    return [(area.anchor[0] - m.lon0) * k, (m.lat1 - area.anchor[1]) * k];
  }
}
