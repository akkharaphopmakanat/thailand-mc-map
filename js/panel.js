// Selected-province card: item, lore, neighbours, and the district (amphoe) → sub-district (tambon) browser.
import { REGIONS } from './config.js';
import { itemSprite, spriteFromRows } from './sprites.js';
import { esc } from './tooltip.js';

export class ProvincePanel {
  /**
   * @param {HTMLElement} el
   * @param {object} o
   * @param {object[]} o.provinces
   * @param {(i: number) => void} o.onSelect          pick another province
   * @param {(i: number) => void} o.onFly             fly camera to province
   * @param {(k: number) => void} o.onDistrict        district row opened
   * @param {(k: number) => void} o.onDistrictHover   -1 when leaving
   */
  constructor(el, { provinces, onSelect, onFly, onDistrict, onDistrictHover }) {
    Object.assign(this, { el, provinces, onSelect, onFly, onDistrict, onDistrictHover });
    this.p = null; this.d = null; this.subs = null; this.open = -1;
  }

  show(p) {
    this.p = p; this.d = null; this.subs = null; this.open = -1;
    const R = REGIONS[p.region];
    const nb = p.adj.map(j => this.provinces[j]);
    this.el.innerHTML = `
      <div class="sel">
        <div class="slot big" aria-hidden="true"><img src="${itemSprite(p).url}" alt=""></div>
        <div>
          <h2 class="sel-name">${esc(p.name.en)}</h2>
          <div class="sel-th">${esc(p.name.th)}</div>
          <div class="sel-item">Iconic item: <b>${esc(p.item.name)}</b></div>
        </div>
      </div>
      <p class="lore">${esc(p.lore)}</p>
      <div class="meta">
        <span class="tag">${R.name} · <span style="font-family:var(--thai)">${R.th}</span></span>
        <span class="tag">minecraft:${R.biome}</span>
        <span class="tag">${p.cells} blocks</span>
      </div>
      <div class="nb"><div class="nb-label">Neighboring provinces</div><div class="chips">${
        nb.map(q => `<button class="chip" data-i="${q.i}"><img src="${itemSprite(q).url}" alt="">${esc(q.name.en)}</button>`).join('')
        || '<span class="nb-label">None (island)</span>'}</div></div>
      <div class="sel-actions">
        <button class="mcbtn" data-act="random">/tp random</button>
        <button class="mcbtn" data-act="fly">Fly to ${esc(p.name.en)}</button>
      </div>
      <section class="dist" aria-label="Districts">
        <div class="dist-head"><h3>Districts <span class="th">อำเภอ / ตำบล</span></h3><span class="count" data-el="count"></span></div>
        <label for="dq" style="position:absolute;left:-9999px">Filter districts and sub-districts</label>
        <input id="dq" class="mcinput" type="search" placeholder="Filter districts, OTOP, items or tambon…" autocomplete="off" disabled>
        <div class="dlist" data-el="list"><p class="muted">Loading districts…</p></div>
      </section>`;
    this.el.querySelectorAll('.chip').forEach(b => b.onclick = () => this.onSelect(+b.dataset.i));
    this.el.querySelector('[data-act="random"]').onclick = () => {
      let j;
      do j = Math.floor(Math.random() * this.provinces.length); while (j === p.i);
      this.onSelect(j);
    };
    this.el.querySelector('[data-act="fly"]').onclick = () => this.onFly(p.i);
    this.q = this.el.querySelector('#dq');
    this.q.addEventListener('input', () => this._renderList());
  }

  /** District raster + sub-district names arrived for province p. */
  setDistricts(p, d, subs) {
    if (p !== this.p) return;
    this.d = d; this.subs = subs;
    this.q.disabled = false;
    const nSub = Object.values(subs.districts).reduce((a, l) => a + l.length, 0);
    this.el.querySelector('[data-el="count"]').textContent = `${d.districts.length} amphoe · ${nSub} tambon`;
    this._renderList();
  }

  setError(p, msg) {
    if (p !== this.p) return;
    this.el.querySelector('[data-el="list"]').innerHTML = `<p class="muted">${esc(msg)}</p>`;
  }

  _icon(dist) {
    const id = dist.item?.sprite;
    return id ? spriteFromRows('d:' + id, this.d.sprites?.[id]).url : '';
  }

  _tambon(k) { return this.subs?.districts[String(this.d.districts[k].id)] || []; }

  _renderList() {
    const list = this.el.querySelector('[data-el="list"]');
    const q = this.q.value.trim().toLowerCase();
    const has = (n) => n.en.toLowerCase().includes(q) || n.th.includes(q);
    const hasDistrict = (d) => has(d.name) || (d.item?.name || '').toLowerCase().includes(q) ||
      (d.item?.otop?.example || '').includes(q) || (d.landmark?.name || '').toLowerCase().includes(q);
    const order = this.d.districts.map((_, k) => k)
      .sort((a, b) => this.d.districts[a].name.en.localeCompare(this.d.districts[b].name.en));
    const rows = [];
    for (const k of order) {
      const dist = this.d.districts[k];
      const tambon = this._tambon(k);
      const tHits = q ? tambon.filter(t => has(t.name) || String(t.zip).startsWith(q)) : [];
      if (q && !hasDistrict(dist) && !tHits.length) continue;
      const expanded = k === this.open || (q && tHits.length > 0 && !hasDistrict(dist));
      const hitIds = new Set(tHits.map(t => t.id));
      rows.push(`
        <button class="drow${dist.cells ? '' : ' nogeo'}" data-k="${k}" aria-expanded="${expanded}">
          <img class="dicon" src="${this._icon(dist)}" alt="">
          <span class="dname">${esc(dist.name.en)}<span class="th">${esc(dist.name.th)}</span>
            <span class="ditem ${esc(dist.item?.kind || '')}">${esc(dist.item?.name || '')}</span></span>
          <span class="n">${q && tHits.length ? `${tHits.length}/` : ''}${tambon.length} tambon</span>
        </button>
        <ul class="tlist" ${expanded ? '' : 'hidden'}>${dist.item ? `<li class="dnote">${esc(dist.item.note)}</li>` : ''}${
          dist.landmark && dist.item?.kind !== 'landmark' ? `<li class="dnote">★ Landmark: ${esc(dist.landmark.name)}. ${esc(dist.landmark.note)}</li>` : ''}${tambon.map(t => `
          <li class="${hitIds.has(t.id) ? 'tl-hit' : ''}">${esc(t.name.en)}<span class="th">${esc(t.name.th)}</span><span class="zip">${t.zip || ''}</span></li>`).join('')
          || '<li>No sub-district data</li>'}</ul>`);
    }
    list.innerHTML = rows.join('') || '<p class="muted">Nothing matches.</p>';
    list.querySelectorAll('.drow').forEach(b => {
      const k = +b.dataset.k;
      b.onclick = () => {
        const opening = b.getAttribute('aria-expanded') !== 'true';
        this.openDistrict(opening ? k : -1);
        if (opening) this.onDistrict(k);
      };
      b.onmouseenter = () => this.onDistrictHover(k);
      b.onmouseleave = () => this.onDistrictHover(-1);
    });
  }

  /** Expand district k (collapse all when -1) and scroll it into view. */
  openDistrict(k) {
    this.open = k;
    if (!this.d) return;
    this.el.querySelectorAll('.drow').forEach(b => {
      const on = +b.dataset.k === k;
      b.setAttribute('aria-expanded', on);
      b.nextElementSibling.hidden = !on;
      if (on) b.scrollIntoView({ block: 'nearest' });
    });
  }

  highlightDistrict(k) {
    this.el.querySelectorAll('.drow').forEach(b => b.classList.toggle('hl', +b.dataset.k === k));
  }
}
