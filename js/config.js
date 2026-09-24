// Shared constants: sprite palette, regions/biomes, map labels.

/** World pixels per map block when the terrain canvas is rendered (200 px per degree with 0.005° blocks,
 *  one pixel per block like a Minecraft map item). */
export const B = 1;

/** Sprite palette. Each letter in a province's `item.sprite` rows maps to one colour; '.' is transparent. */
export const PAL = {
  k: '#1d1d21', w: '#f7f7f2', g: '#c3c3c3', G: '#7a7a7a', d: '#4a4a4f', r: '#e0412f', R: '#8f231b',
  o: '#f39a2b', y: '#ffd83d', Y: '#c9971c', l: '#86d34a', e: '#3f9a2e', E: '#23581b', b: '#9a6634',
  B: '#5c3a1a', t: '#ead39a', T: '#c4a360', c: '#6fe0ec', C: '#2aa7b8', u: '#3f78e0', U: '#233f8f',
  n: '#1b2552', p: '#f59ac4', P: '#9a4fd0', m: '#c9368f', s: '#f2bf93', h: '#f7ae2a', f: '#fff27a',
  x: '#ece5d0',
};

/** Six-region system. `amp` = terrain relief, `forest` = tree threshold (lower means more trees). */
export const REGIONS = {
  N:  { name: 'North',     th: 'ภาคเหนือ',              biome: 'old_growth_pine_taiga', base: [64, 116, 46],  amp: 1.0,  forest: .40 },
  NE: { name: 'Northeast', th: 'ภาคตะวันออกเฉียงเหนือ', biome: 'savanna_plateau',       base: [150, 156, 72], amp: .30,  forest: .70 },
  C:  { name: 'Central',   th: 'ภาคกลาง',               biome: 'plains',                base: [106, 170, 60], amp: .12,  forest: .82 },
  E:  { name: 'East',      th: 'ภาคตะวันออก',           biome: 'sparse_jungle',         base: [72, 150, 50],  amp: .45,  forest: .50 },
  W:  { name: 'West',      th: 'ภาคตะวันตก',            biome: 'windswept_hills',       base: [90, 136, 62],  amp: .90,  forest: .46 },
  S:  { name: 'South',     th: 'ภาคใต้',                biome: 'jungle',                base: [46, 138, 54],  amp: .55,  forest: .38 },
};
export const REGION_ORDER = ['N', 'NE', 'C', 'E', 'W', 'S'];

/**
 * Biomes by Minecraft id: the six Thai regions' plus a few for other countries. `base` grass
 * colour, `forest` tree threshold (lower = more trees), `paddy` rice fields on the plains,
 * `leaves` / `grass` block textures in 3D. Each state / region of another country names one.
 */
export const BIOMES = {
  ...Object.fromEntries(Object.entries(REGIONS).map(([k, R]) => [R.biome, {
    id: R.biome, base: R.base, forest: R.forest, paddy: k === 'C',
    leaves: k === 'S' || k === 'E' ? 'jungleleaves' : 'leaves', grass: k === 'NE' ? 'dry_grass' : 'grass' }])),
  mangrove_swamp: { id: 'mangrove_swamp', base: [70, 118, 58], forest: .42, paddy: false, leaves: 'jungleleaves', grass: 'grass' },
  meadow: { id: 'meadow', base: [112, 178, 72], forest: .78, paddy: false, leaves: 'leaves', grass: 'grass' },
};
export const BIOME_IDS = Object.keys(BIOMES);          // tile.bio stores 1 + index into this

/** Brightness per province shade index so neighbouring provinces differ. */
export const SHADES = [1, .9, 1.1, .95, 1.05, .98, 1.02, .93];

/** Seas: [label, lat, lon]. Country names come from the backdrops in data/map.json. */
export const MAP_LABELS = [
  ['ANDAMAN SEA', 9.5, 96.0], ['GULF OF THAILAND', 10.4, 101.3], ['SOUTH CHINA SEA', 13.5, 113.5],
  ['JAVA SEA', -5.0, 111.0], ['CELEBES SEA', 3.5, 122.5], ['SULU SEA', 8.5, 120.0],
  ['PHILIPPINE SEA', 15.0, 128.0], ['INDIAN OCEAN', -5.0, 95.5], ['BANDA SEA', -6.0, 126.5],
  ['BAY OF BENGAL', 16.0, 92.8],
];
