// Loads data/map.json, every data/provinces/<slug>/province.json, and (on demand)
// each province's districts.json and subdistricts.json.
import { decodeRows } from './rle.js';

async function json(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

/**
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<{map: object, grid: Int16Array, provinces: object[], roads: object|null, elev: Int16Array|null}>}
 */
export async function loadAtlas(onProgress = () => {}) {
  const [map, elevation, roads] = await Promise.all([
    json('data/map.json'),
    loadElevation().catch(() => null),
    json('data/roads.json').catch(() => null),
  ]);
  const grid = decodeRows(map.rows, map.W, map.H, map.chars, { '.': -1, ',': -2 });
  let done = 0;
  const total = map.provinces.length;
  const provinces = await Promise.all(map.provinces.map(async (slug, i) => {
    const p = await json(`data/provinces/${slug}/province.json`);
    onProgress(++done, total);
    return { ...p, i, anchor: map.anchor[i], shade: map.shade[i], adj: map.adj[i], cells: map.cells[i], bb: [map.W, map.H, 0, 0] };
  }));
  // Block bounding box per province, used to fly the camera
  for (let r = 0; r < map.H; r++) {
    for (let c = 0; c < map.W; c++) {
      const v = grid[r * map.W + c];
      if (v < 0) continue;
      const b = provinces[v].bb;
      if (c < b[0]) b[0] = c;
      if (r < b[1]) b[1] = r;
      if (c > b[2]) b[2] = c;
      if (r > b[3]) b[3] = r;
    }
  }
  return { map, grid, provinces, roads, elev: elevation };
}

/** data/elevation.bin: int16 little-endian metres per block (negative = sea depth). */
async function loadElevation() {
  const meta = await json('data/elevation.json');
  const res = await fetch(`data/${meta.file}`);
  if (!res.ok) throw new Error(`elevation ${res.status}`);
  const buf = await res.arrayBuffer();
  const view = new DataView(buf), out = new Int16Array(buf.byteLength >> 1);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

const districtCache = new Map();
const subdistrictCache = new Map();

/** Amphoe/khet raster for one province: {res, lon0, lat1, w, h, districts[], grid}. */
export function loadDistricts(slug) {
  if (!districtCache.has(slug)) {
    districtCache.set(slug, json(`data/provinces/${slug}/districts.json`).then(d => ({
      ...d,
      grid: decodeRows(d.rows, d.w, d.h, d.chars, { '.': -1 }),
    })).catch(e => { districtCache.delete(slug); throw e; }));
  }
  return districtCache.get(slug);
}

/** Tambon/khwaeng names and postcodes keyed by district id. */
export function loadSubdistricts(slug) {
  if (!subdistrictCache.has(slug)) {
    subdistrictCache.set(slug, json(`data/provinces/${slug}/subdistricts.json`)
      .catch(e => { subdistrictCache.delete(slug); throw e; }));
  }
  return subdistrictCache.get(slug);
}
