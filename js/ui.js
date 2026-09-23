// Page UI helpers: the Minecraft-style tooltip, the F3 debug overlay and the credits panel.
import { REGIONS } from './config.js';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export class Tooltip {
  constructor(el) { this.el = el; }

  show(html, x, y) {
    const el = this.el;
    el.innerHTML = html;
    el.hidden = false;
    const r = el.getBoundingClientRect();
    let tx = x + 16, ty = y + 14;
    if (tx + r.width > innerWidth - 8) tx = x - r.width - 12;
    if (ty + r.height > innerHeight - 8) ty = y - r.height - 10;
    el.style.transform = `translate(${Math.max(4, tx)}px,${Math.max(4, ty)}px)`;
  }

  hide() { this.el.hidden = true; }
}

export function provinceTip(p, hint = '') {
  const R = REGIONS[p.region];
  return `<div class="t-name">${esc(p.name.en)}</div><div class="t-th">${esc(p.name.th)}</div>` +
    `<div class="t-item">✦ ${esc(p.item.name)}</div>` +
    `<div class="t-reg">${R.name} · ${R.biome.replace(/_/g, ' ')}</div>` +
    (hint ? `<div class="t-hint">${esc(hint)}</div>` : '');
}

export function districtTip(p, d, hint = '') {
  return `<div class="t-name">${esc(d.name.en)}</div><div class="t-th">${esc(d.name.th)}</div>` +
    (d.item ? `<div class="t-item">✦ ${esc(d.item.name)}${d.item.kind === 'otop' ? ' <span class="t-otop">OTOP</span>' : ''}</div>` +
      `<div class="t-lore">${esc(d.item.note)}</div>` : '') +
    (d.landmark && d.item?.kind !== 'landmark' ? `<div class="t-lm">★ ${esc(d.landmark.name)}</div>` : '') +
    `<div class="t-reg">District of ${esc(p.name.en)}</div>` +
    (hint ? `<div class="t-hint">${esc(hint)}</div>` : '');
}

/* ---------------- F3 debug overlay ---------------- */
// Coordinates, elevation, biome, province and district (or country) under the pointer.
export function renderF3(el, atlas, pick, layer) {
  const { map, provinces } = atlas;
  const lines = ['ThaiCraft Atlas · 77 provinces · 928 districts'];
  if (pick) {
    const lat = map.lat1 - (pick.r + .5) * map.S, lon = map.lon0 + (pick.c + .5) * map.S;
    lines.push(`Lat ${Math.abs(lat).toFixed(2)}° ${lat < 0 ? 'S' : 'N'}  Lon ${lon.toFixed(2)}° E`);
    const inside = pick.r >= 0 && pick.c >= 0 && pick.r < map.H && pick.c < map.W;
    const e = inside ? atlas.elev?.[pick.r * map.W + pick.c] : null;
    if (e != null) lines.push(e < 0 && pick.v === -1 ? `Depth: ${-e} m` : `Elevation: ${Math.max(e, 0)} m`);
    const p = pick.province >= 0 ? provinces[pick.province] : null;
    lines.push('Biome: ' + (p ? 'minecraft:' + REGIONS[p.region].biome : pick.country ? '(outside Thailand)' : 'minecraft:ocean'));
    if (!p && pick.country) lines.push(`Country: ${esc(pick.country)}`);
    if (p) lines.push(`Province: ${esc(p.name.en)} <span class="th">${esc(p.name.th)}</span>`);
    if (p && layer && pick.district >= 0) {
      const d = layer.districts[pick.district];
      lines.push(`District: ${esc(d.name.en)} <span class="th">${esc(d.name.th)}</span>`);
    }
  }
  el.innerHTML = lines.map(l => `<span>${l}</span>`).join('');
}

/* ---------------- credits panel ---------------- */
// Built from data/sources.json.
const link = (url, text) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`;

export async function renderCredits(el) {
  let src;
  try {
    const res = await fetch('data/sources.json');
    if (!res.ok) throw new Error(res.status);
    src = await res.json();
  } catch {
    return; // keep the static fallback already in the page
  }
  el.innerHTML = `
    <h2>Credits</h2>
    <p class="cr-author">Made by ${link(src.author.url, src.author.name)}
      · ${link(src.author.repo, 'source on GitHub')}</p>
    <details class="cr-section">
      <summary><h3>Data references <span class="cr-count">${src.data.length} sources</span></h3></summary>
    <div class="cr-acc">${src.data.map(d => `
      <details>
        <summary>${esc(d.title)}<span class="cr-lic">${esc(d.license)}</span></summary>
        <div class="cr-body">
          <p class="cr-meta">${esc(d.author)}</p>
          <p class="cr-use">${esc(d.used_for)}</p>
          ${d.citation ? `<p class="cr-cite">${esc(d.citation)}</p>` : ''}
          <p>${link(d.url, 'Source')}${[].concat(d.download || []).map((u, i) => ` · ${link(u, 'Download' + (i ? ' ' + (i + 1) : ''))}`).join('')}</p>
        </div>
      </details>`).join('')}
    </div>
    </details>
    <h3>Fonts</h3>
    <p class="cr-fonts">${src.fonts.map(f => `${link(f.url, f.title)} (${esc(f.license)})`).join(' · ')}</p>
    <ul class="cr-notes">${src.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`;
}
