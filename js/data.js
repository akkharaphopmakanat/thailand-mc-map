// Loads data/map.json, every data/provinces/<slug>/province.json, and (on demand)
// each province's districts.json and subdistricts.json, and other countries' area district files.
import { decodeRows } from './rle.js';
import { decodeBackdrop } from './backdrop.js';

async function json(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

/**
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<object>} {map, grid, provinces, rivers, elev, roads, streams, asean, world}
 */
export async function loadAtlas(onProgress = () => {}) {
  const [map, blocks] = await Promise.all([
    json('data/map.json'),
    json('data/blocks.json').catch(() => null),
  ]);
  const rivers = blocks?.rivers || null;
  const [elevation, aseanElev, worldElev] = await Promise.all([
    map.elevation ? loadElevation(map.elevation).catch(() => null) : null,
    map.asean ? loadElevation(map.asean.elevation).catch(() => null) : null,
    map.world ? loadElevation(map.world.elevation).catch(() => null) : null,
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
  return {
    map, grid, provinces, rivers, elev: elevation,
    // low-detail backdrops: the ASEAN region and the whole world
    asean: map.asean ? decodeBackdrop(map.asean, aseanElev) : null,
    world: map.world ? decodeBackdrop(map.world, worldElev) : null,
    // per-block OSM layers: roads 1 local, 2–3 medium, 4 large, 5 railway; water 1 small, 2 main river
    roads: blocks ? decodeRows(blocks.roads, blocks.W, blocks.H, '012345', { '.': 0 }) : null,
    streams: blocks ? decodeRows(blocks.water, blocks.W, blocks.H, '0123', { '.': 0 }) : null,   // 1 small, 2 main river, 3 lake
  };
}

/** data/elevation.png: metres per block = R * 256 + G - 32768 (negative = sea depth). */
async function loadElevation(meta) {
  const res = await fetch(`data/${meta.file}`);
  if (!res.ok) throw new Error(`elevation ${res.status}`);
  const blob = await res.blob();
  // no colour management or alpha premultiplication, so pixel values stay exact
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const cv = document.createElement('canvas');
  cv.width = bmp.width; cv.height = bmp.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  const out = new Int16Array(bmp.width * bmp.height);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4] * 256 + px[i * 4 + 1] - 32768;
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

/**
 * District raster of one state / region of another detailed country (same shape as a Thai
 * province's districts.json; each district also lists its places).
 */
export function loadAreaDistricts(code, id) {
  const key = `${code}:${id}`;
  if (!districtCache.has(key)) {
    districtCache.set(key, json(`data/countries/${code}/area-${id}.json`).then(d => ({
      ...d,
      grid: decodeRows(d.rows, d.w, d.h, d.chars, { '.': -1 }),
    })).catch(e => { districtCache.delete(key); throw e; }));
  }
  return districtCache.get(key);
}

/** Tambon/khwaeng names and postcodes keyed by district id. */
export function loadSubdistricts(slug) {
  if (!subdistrictCache.has(slug)) {
    subdistrictCache.set(slug, json(`data/provinces/${slug}/subdistricts.json`)
      .catch(e => { subdistrictCache.delete(slug); throw e; }));
  }
  return subdistrictCache.get(slug);
}
