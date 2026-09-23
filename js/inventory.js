// Creative-inventory grid of all province items, with region tabs and search.
import { REGIONS, REGION_ORDER } from './config.js';
import { itemSprite } from './sprites.js';
import { provinceTip } from './tooltip.js';

export class Inventory {
  constructor({ tabsEl, gridEl, searchEl, titleEl, countEl, provinces, tooltip, onSelect, onHover }) {
    Object.assign(this, { tabsEl, gridEl, searchEl, titleEl, countEl, provinces, tooltip, onSelect, onHover });
    this.tab = 'all';
    this.selected = -1;
    this._buildTabs();
    searchEl.addEventListener('input', () => this.render());
    searchEl.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const hit = this.provinces.find(p => this._matches(p, this._query()));
      if (this._query() && hit) this.onSelect(hit.i);
    });
    this.render();
  }

  _query() { return this.searchEl.value.trim().toLowerCase(); }

  _matches(p, q) {
    return !q || p.name.en.toLowerCase().includes(q) || p.name.th.includes(q) || p.item.name.toLowerCase().includes(q);
  }

  _buildTabs() {
    const defs = [['all', 'All provinces', null],
      ...REGION_ORDER.map(k => [k, `${REGIONS[k].name} · ${REGIONS[k].th}`, this.provinces.find(p => p.region === k)])];
    for (const [key, label, sample] of defs) {
      const b = document.createElement('button');
      b.className = 'tab';
      b.setAttribute('role', 'tab');
      b.id = 'tab-' + key;
      b.title = label;
      b.setAttribute('aria-label', label);
      b.innerHTML = sample ? `<img src="${itemSprite(sample).url}" alt="">` : '<span class="all">ALL</span>';
      b.onclick = () => { this.tab = key; this.render(); };
      this.tabsEl.appendChild(b);
    }
  }

  setSelected(i) {
    this.selected = i;
    this.gridEl.querySelectorAll('.slot').forEach(s => s.classList.toggle('on', +s.dataset.i === i));
  }

  render() {
    const { tab, gridEl } = this;
    this.tabsEl.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', t.id === 'tab-' + tab));
    const list = this.provinces.filter(p => tab === 'all' || p.region === tab)
      .sort((a, b) => REGION_ORDER.indexOf(a.region) - REGION_ORDER.indexOf(b.region) || a.name.en.localeCompare(b.name.en));
    const q = this._query();
    let hits = 0;
    gridEl.innerHTML = '';
    const total = Math.max(27, Math.ceil(list.length / 9) * 9);
    for (let n = 0; n < total; n++) {
      const p = list[n];
      const s = document.createElement(p ? 'button' : 'div');
      s.className = 'slot';
      if (p) {
        const match = this._matches(p, q);
        if (match) hits++;
        s.dataset.i = p.i;
        s.setAttribute('aria-label', `${p.name.en}: ${p.item.name}`);
        s.innerHTML = `<img src="${itemSprite(p).url}" alt="">`;
        s.classList.toggle('dim', !match);
        s.classList.toggle('on', p.i === this.selected);
        s.onclick = () => this.onSelect(p.i);
        s.onmouseenter = e => { this.onHover(p.i); this.tooltip.show(provinceTip(p), e.clientX, e.clientY); };
        s.onmousemove = e => this.tooltip.show(provinceTip(p), e.clientX, e.clientY);
        s.onmouseleave = () => { this.onHover(-1); this.tooltip.hide(); };
      }
      gridEl.appendChild(s);
    }
    this.titleEl.textContent = tab === 'all' ? 'All provinces' : REGIONS[tab].name;
    this.countEl.textContent = q ? `${hits} match${hits === 1 ? '' : 'es'}` : `${list.length} provinces`;
  }
}
