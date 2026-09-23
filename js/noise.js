// Deterministic hash + value noise used for terrain texture and relief.

/** Hash of integer coords and a seed to [0, 1). */
export function h2(x, y, s) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise. */
export function vn(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = h2(xi, yi, s), b = h2(xi + 1, yi, s), c = h2(xi, yi + 1, s), d = h2(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Three-octave fractal noise, roughly 0.2–0.8. */
export function fbm(x, y, s) {
  return vn(x / 14, y / 14, s) * .55 + vn(x / 6, y / 6, s + 1) * .3 + vn(x / 2.5, y / 2.5, s + 2) * .15;
}
