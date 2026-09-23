// Builds the drawable district (amphoe) layer for one province from its districts.json raster.
import { B } from './config.js';
import { spriteFromRows } from './sprites.js';

/**
 * @param {object} d    result of loadDistricts()
 * @param {object} map  data/map.json (for the world coordinate frame)
 */
export function buildDistrictLayer(d, map) {
  const { w, h, grid } = d;
  const k = d.res / map.S * B;                    // world px per district cell
  const ox = (d.lon0 - map.lon0) / map.S * B;     // world px of the raster's top-left corner
  const oy = (map.lat1 - d.lat1) / map.S * B;
  const X = c => ox + c * k, Y = r => oy + r * k;

  const n = d.districts.length;
  const fills = Array.from({ length: n }, () => new Path2D());
  const edges = Array.from({ length: n }, () => new Path2D());
  const inner = new Path2D();                     // borders between two districts
  const bb = Array.from({ length: n }, () => [Infinity, Infinity, -Infinity, -Infinity]);

  const at = (r, c) => (r < 0 || c < 0 || r >= h || c >= w) ? -1 : grid[r * w + c];
  const seg = (P, x0, y0, x1, y1) => { P.moveTo(x0, y0); P.lineTo(x1, y1); };

  for (let r = 0; r < h; r++) {
    let c = 0;
    while (c < w) {
      const v = grid[r * w + c];
      let e = c;
      while (e < w && grid[r * w + e] === v) e++;
      if (v >= 0) {
        fills[v].rect(X(c), Y(r), (e - c) * k, k);
        const b = bb[v];
        b[0] = Math.min(b[0], X(c)); b[1] = Math.min(b[1], Y(r)); b[2] = Math.max(b[2], X(e)); b[3] = Math.max(b[3], Y(r + 1));
      }
      c = e;
    }
    for (c = 0; c < w; c++) {
      const v = grid[r * w + c];
      if (v < 0) continue;
      const up = at(r - 1, c), dn = at(r + 1, c), lf = at(r, c - 1), rt = at(r, c + 1);
      if (up !== v) seg(edges[v], X(c), Y(r), X(c + 1), Y(r));
      if (dn !== v) seg(edges[v], X(c), Y(r + 1), X(c + 1), Y(r + 1));
      if (lf !== v) seg(edges[v], X(c), Y(r), X(c), Y(r + 1));
      if (rt !== v) seg(edges[v], X(c + 1), Y(r), X(c + 1), Y(r + 1));
      // each shared border once (right and bottom neighbours)
      if (rt >= 0 && rt !== v) seg(inner, X(c + 1), Y(r), X(c + 1), Y(r + 1));
      if (dn >= 0 && dn !== v) seg(inner, X(c), Y(r + 1), X(c + 1), Y(r + 1));
    }
  }

  return {
    slug: d.province,
    districts: d.districts,
    k, fills, edges, inner, bb,
    /** Sprite for district i's iconic item. */
    sprite(i) {
      const id = d.districts[i].item?.sprite;
      return spriteFromRows('d:' + id, d.sprites?.[id]);
    },
    /** World-pixel label point for district i, or null when it has no outline. */
    anchor(i) {
      const a = d.districts[i].anchor;
      return a ? [X(a[1] + .5), Y(a[0] + .5)] : null;
    },
    /** District index under a world-pixel point, or -1. */
    hit(wx, wy) {
      return at(Math.floor((wy - oy) / k), Math.floor((wx - ox) / k));
    },
  };
}
