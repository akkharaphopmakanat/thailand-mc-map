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
 * @returns {Promise<object>} {map, grid, provinces, rivers, elev, roads, streams, settlements, towns}
 */
export async function loadAtlas(onProgress = () => {}) {
  const [map, blocks, rivers, towns] = await Promise.all([
    json('data/map.json'),
    json('data/blocks.json').catch(() => null),
    json('data/rivers.json').catch(() => null),
    json('data/towns.json').catch(() => null),
  ]);
  const elevation = map.elevation ? await loadElevation(map.elevation).catch(() => null) : null;
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
    // per-block OSM layers: roads 1 tertiary … 4 motorway/trunk, 5 railway; water 1 river
    roads: blocks ? decodeRows(blocks.roads, blocks.W, blocks.H, '012345', { '.': 0 }) : null,
    streams: blocks ? decodeRows(blocks.water, blocks.W, blocks.H, '01', { '.': 0 }) : null,
    settlements: blocks?.settlements ? decodeRows(blocks.settlements, blocks.W, blocks.H, '0123', { '.': 0 }) : null,
    towns: towns ? towns.towns.map(([name, th, x, y, kind, population, district]) => ({ name, th, x, y, kind, population, district })) : [],
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

/** Villages (GeoNames) of one province, keyed by district id: [[name, th, x, y], …] in world px. */
export async function loadVillages(slug) {
  return (await loadSubdistricts(slug)).villages?.districts || {};
}

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
