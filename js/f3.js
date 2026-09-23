// F3 debug-screen overlay: coordinates, biome, province and district under the pointer.
import { REGIONS } from './config.js';
import { esc } from './tooltip.js';

export function renderF3(el, atlas, pick, layer) {
  const { map, provinces } = atlas;
  const lines = ['ThaiCraft Atlas · 77 provinces · 928 districts'];
  if (pick) {
    const lat = map.lat1 - (pick.r + .5) * map.S, lon = map.lon0 + (pick.c + .5) * map.S;
    lines.push(`Lat ${lat.toFixed(2)}° N  Lon ${lon.toFixed(2)}° E`);
    const e = atlas.elev?.[pick.r * map.W + pick.c];
    if (e != null) lines.push(e < 0 && pick.v === -1 ? `Depth: ${-e} m` : `Elevation: ${Math.max(e, 0)} m`);
    const p = pick.province >= 0 ? provinces[pick.province] : null;
    lines.push('Biome: ' + (p ? 'minecraft:' + REGIONS[p.region].biome : pick.v === -2 ? '(outside Thailand)' : 'minecraft:ocean'));
    if (p) lines.push(`Province: ${esc(p.name.en)} <span class="th">${esc(p.name.th)}</span>`);
    if (p && layer && pick.district >= 0) {
      const d = layer.districts[pick.district];
      lines.push(`District: ${esc(d.name.en)} <span class="th">${esc(d.name.th)}</span>`);
    }
  }
  el.innerHTML = lines.map(l => `<span>${l}</span>`).join('');
}
