// Shared constants: sprite palette, regions/biomes, map labels.

/** World pixels per map block when the terrain canvas is rendered (200 px per degree with 0.01° blocks). */
export const B = 2;

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

/** Brightness per province shade index so neighbouring provinces differ. */
export const SHADES = [1, .9, 1.1, .95, 1.05, .98, 1.02, .93];

/** Seas and neighbouring countries: [label, lat, lon]. */
export const MAP_LABELS = [
  ['ANDAMAN SEA', 8.6, 97.65], ['GULF OF THAILAND', 10.4, 101.3], ['MYANMAR', 17.6, 97.55],
  ['LAOS', 19.3, 102.9], ['CAMBODIA', 12.9, 104.2], ['MALAYSIA', 5.75, 101.25], ['VIETNAM', 19.9, 105.1],
];
