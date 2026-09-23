// Everything outside Thailand's own map, in Minecraft-map style:
// - low-detail backdrops of the whole world (0.25°, ~27 km blocks) and the ASEAN region (0.05°, ~5.5 km);
//   countries marked `detail` (ASEAN, Hong Kong, Macau) in full colour, the rest dimmer;
// - detailed 550 m tiles (2° × 2°) for ASEAN, Hong Kong and Macau, streamed as the map pans and zooms.
import { B } from './config.js';
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
  /** @param {object} map  data/map.json (for the world-pixel frame) */
  constructor(map) {
    this.map = map;
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
      const res = await fetch(`data/tiles/${key}.png`);
      if (!res.ok) throw new Error(res.status);
      const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const n = bmp.width;
      const cv = document.createElement('canvas');
      cv.width = cv.height = n;
      const x = cv.getContext('2d', { willReadFrequently: true });
      x.drawImage(bmp, 0, 0);
      const px = x.getImageData(0, 0, n, n).data;
      const elev = new Int16Array(n * n), country = new Uint8Array(n * n);
      for (let i = 0; i < n * n; i++) { elev[i] = px[i * 4] * 256 + px[i * 4 + 1] - 32768; country[i] = px[i * 4 + 2]; }
      const tile = { tx, ty, n, elev, country, canvas: cv };
      paintTile(tile, this.index);
      this.cache.set(key, tile);
      while (this.cache.size > CACHE) this.cache.delete(this.cache.keys().next().value);
      this.onLoad();
    } catch { /* missing tile: the backdrop shows through */ }
    this.loading.delete(key);
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
    return { country: t.country[i] ? I.countries[t.country[i] - 1] : null, elevation: t.elev[i] };
  }
}

/** Paint a decoded tile into its canvas, one pixel per 550 m block. */
export function paintTile(t, I) {
  const { n, elev, country, canvas } = t;
  const x = canvas.getContext('2d');
  const img = x.createImageData(n, n), px = img.data;
  const level = i => Math.floor(Math.max(elev[i], 0) / 40);
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
      tree = vn(gc / 24, gr / 24, 5) > .46 - Math.min(Math.max(e, 0), 1500) / 3000 && h2(gc, gr, 6) < .6;
      if (coast && e < 40) rgb = [222, 208, 160];
      else if (e > 1350 + h2(gc, gr, 7) * 250) rgb = [132, 132, 134];
      else if (tree) rgb = [42, 96, 36];
      else if (e < 60 && vn(gc / 20, gr / 20, 21) > .55) rgb = [126, 186, 78];     // paddy fields on the plains
      else rgb = [80, 146, 56];
      const detail = I.countries[v - 1]?.detail;
      if (!detail) { const g = (rgb[0] + rgb[1] + rgb[2]) / 3; rgb = rgb.map(q => (q * .7 + g * .3) * .62); }
      if (r > 0 && country[i - n]) { const a = level(i) + (tree ? 1 : 0), b = level(i - n); rgb = rgb.map(q => q * (a > b ? 1.12 : a < b ? .84 : 1)); }
      if ((c + 1 < n && country[i + 1] && country[i + 1] !== v) || (r + 1 < n && country[i + n] && country[i + n] !== v)) rgb = rgb.map(q => q * .45);
    }
    const f = tree ? .78 + h2(gc, gr, 8) * .4 : .93 + h2(gc, gr, 3) * .14, o = i * 4;
    px[o] = Math.min(255, rgb[0] * f); px[o + 1] = Math.min(255, rgb[1] * f); px[o + 2] = Math.min(255, rgb[2] * f); px[o + 3] = 255;
  }
  x.putImageData(img, 0, 0);
}
