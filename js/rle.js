// Decoder for the run-length-encoded raster rows written by tools/build_data.py.
// Each row is a string of symbols; "X~12~" means symbol X repeated 12 times.

/**
 * @param {string[]} rows
 * @param {number} w
 * @param {number} h
 * @param {string} chars   symbol for index 0, 1, 2, …
 * @param {Record<string, number>} specials  extra symbols, e.g. {'.': -1}
 * @returns {Int16Array} w*h indices, -1 where empty
 */
export function decodeRows(rows, w, h, chars, specials = {}) {
  const lookup = new Map();
  [...chars].forEach((ch, i) => lookup.set(ch, i));
  for (const [ch, v] of Object.entries(specials)) lookup.set(ch, v);
  const out = new Int16Array(w * h).fill(-1);
  for (let r = 0; r < h; r++) {
    const s = rows[r] || '';
    let c = 0, i = 0;
    while (i < s.length && c < w) {
      const ch = s[i++];
      let n = 1;
      if (s[i] === '~') {
        const j = s.indexOf('~', i + 1);
        n = +s.slice(i + 1, j);
        i = j + 1;
      }
      const v = lookup.has(ch) ? lookup.get(ch) : -1;
      out.fill(v, r * w + c, r * w + Math.min(w, c + n));
      c += n;
    }
  }
  return out;
}
