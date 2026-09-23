// Minecraft-style item tooltip that follows the pointer.
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
    `<div class="t-reg">District of ${esc(p.name.en)}</div>` +
    (hint ? `<div class="t-hint">${esc(hint)}</div>` : '');
}
