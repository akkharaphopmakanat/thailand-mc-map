// Selected-province card: item, lore, neighbours, and the district (amphoe) → sub-district (tambon) browser.
import { REGIONS } from './config.js';
import { itemSprite, spriteFromRows } from './sprites.js';
import { esc } from './ui.js';

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
    this.p = p; this.d = null; this.subs = null; this.open = -1; this.area = null;
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
    if (p !== this.p) return;                    // null: the selected area of another country
    if (!this.el.querySelector('[data-el="list"]')) return;
    this.el.querySelector('[data-el="list"]').innerHTML = `<p class="muted">${esc(msg)}</p>`;
  }

  _icon(dist) {
    const id = dist.item?.sprite;
    return id ? spriteFromRows('d:' + id, this.d.sprites?.[id]).url : '';
  }

  /** Sub-districts of district k: tambon (Thailand) or places (other countries), as {id, name, extra}. */
  _tambon(k) {
    const dist = this.d.districts[k];
    if (this.area) return (dist.places || []).map((pl, i) => ({ id: i, name: pl.name, extra: pl.kind }));
    return (this.subs?.districts[String(dist.id)] || []).map(t => ({ ...t, extra: t.zip }));
  }

  _renderList() {
    const list = this.el.querySelector('[data-el="list"]');
    const q = this.q.value.trim().toLowerCase();
    const local = n => n.th ?? n.local ?? '';
    const has = (n) => n.en.toLowerCase().includes(q) || local(n).toLowerCase().includes(q);
    const subWord = this.area ? 'places' : 'tambon';
    const hasDistrict = (d) => has(d.name) || (d.item?.name || '').toLowerCase().includes(q) ||
      (d.item?.otop?.example || '').includes(q) || (d.landmark?.name || '').toLowerCase().includes(q);
    const order = this.d.districts.map((_, k) => k)
      .sort((a, b) => this.d.districts[a].name.en.localeCompare(this.d.districts[b].name.en));
    const rows = [];
    for (const k of order) {
      const dist = this.d.districts[k];
      const tambon = this._tambon(k);
      const tHits = q ? tambon.filter(t => has(t.name) || String(t.extra ?? '').startsWith(q)) : [];
      if (q && !hasDistrict(dist) && !tHits.length) continue;
      const expanded = k === this.open || (q && tHits.length > 0 && !hasDistrict(dist));
      const hitIds = new Set(tHits.map(t => t.id));
      rows.push(`
        <button class="drow${dist.cells ? '' : ' nogeo'}" data-k="${k}" aria-expanded="${expanded}">
          <img class="dicon" src="${this._icon(dist)}" alt="">
          <span class="dname">${esc(dist.name.en)}<span class="th">${esc(local(dist.name) === dist.name.en ? '' : local(dist.name))}</span>
            <span class="ditem ${esc(dist.item?.kind || '')}">${esc(dist.item?.name || '')}</span></span>
          <span class="n">${q && tHits.length ? `${tHits.length}/` : ''}${tambon.length} ${subWord}</span>
        </button>
        <ul class="tlist" ${expanded ? '' : 'hidden'}>${dist.item ? `<li class="dnote">${esc(dist.item.note)}</li>` : ''}${
          dist.landmark && (this.area || dist.item?.kind !== 'landmark') ? `<li class="dnote">★ Landmark: ${esc(dist.landmark.name)}. ${esc(dist.landmark.note)}</li>` : ''}${tambon.map(t => `
          <li class="${hitIds.has(t.id) ? 'tl-hit' : ''}">${esc(t.name.en)}<span class="th">${esc(local(t.name))}</span><span class="zip">${esc(t.extra || '')}</span></li>`).join('')
          || `<li>No ${this.area ? 'place names' : 'sub-district data'}</li>`}${
          this.area && dist.placeCount > tambon.length ? `<li class="dnote">…and ${dist.placeCount - tambon.length} smaller places</li>` : ''}</ul>`);
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

  /**
   * Card for a state / province / region of another detailed country: item, lore, and its
   * districts. `onArea(area)` selects another area, `onFly(area)` flies the map to it.
   */
  showArea(area, { onArea, onFly }) {
    this.p = null; this.d = null; this.subs = null; this.open = -1; this.area = area;
    const c = area.country;
    const term = c.term[0].toUpperCase() + c.term.slice(1);
    const dTerm = c.districtTerm || 'district';
    const districts = c.districts.filter(d => d.area === area.id).map(d => d.name).sort();
    this.el.innerHTML = `
      <div class="sel">
        <div class="slot big" aria-hidden="true"><img src="${spriteFromRows(`c:${c.code}:${area.id}`, area.item.sprite).url}" alt=""></div>
        <div>
          <h2 class="sel-name">${esc(area.name.en)}</h2>
          <div class="sel-th">${esc(area.name.local && area.name.local !== area.name.en ? area.name.local + ' · ' : '')}${esc(c.name.en)}</div>
          <div class="sel-item">Iconic item: <b>${esc(area.item.name)}</b></div>
        </div>
      </div>
      <p class="lore">${esc(area.lore)}</p>
      <div class="meta">
        <span class="tag">${esc(term)} of ${esc(c.name.en)}</span>
        <span class="tag">${area.blocks} blocks</span>
      </div>
      <div class="nb"><div class="nb-label">Other ${esc(c.term)}s of ${esc(c.name.en)}</div><div class="chips">${
        c.areas.filter(a => a !== area).map(a => `<button class="chip" data-a="${a.id}"><img src="${spriteFromRows(`c:${c.code}:${a.id}`, a.item.sprite).url}" alt="">${esc(a.name.en)}</button>`).join('')}</div></div>
      <div class="sel-actions"><button class="mcbtn" data-act="fly">Fly to ${esc(area.name.en)}</button></div>
      <section class="dist" aria-label="${esc(dTerm)}s">
        <div class="dist-head"><h3>${esc(dTerm[0].toUpperCase() + dTerm.slice(1))}s</h3><span class="count" data-el="count">${districts.length}</span></div>
        <label for="dq" style="position:absolute;left:-9999px">Filter ${esc(dTerm)}s and places</label>
        <input id="dq" class="mcinput" type="search" placeholder="Filter ${esc(dTerm)}s, items or places…" autocomplete="off" disabled>
        <div class="dlist" data-el="list"><p class="muted">Loading ${esc(dTerm)}s…</p></div>
      </section>`;
    this.el.querySelectorAll('.chip').forEach(b => b.onclick = () => onArea(c.areas[+b.dataset.a - 1]));
    this.el.querySelector('[data-act="fly"]').onclick = () => onFly(area);
    this.q = this.el.querySelector('#dq');
    this.q.addEventListener('input', () => this._renderList());
  }

  /** District raster (with items and places) arrived for the selected area of another country. */
  setAreaDistricts(area, d) {
    if (area !== this.area) return;
    this.d = d;
    this.q.disabled = false;
    const c = area.country, dTerm = c.districtTerm || 'district';
    const nPlaces = d.districts.reduce((a, x) => a + x.placeCount, 0);
    this.el.querySelector('[data-el="count"]').textContent =
      `${d.districts.length} ${d.districts.length === 1 ? dTerm : dTerm + 's'} · ${nPlaces} places`;
    this._renderList();
  }
}
