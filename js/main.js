// Entry point: load data, build the world, and wire map ⇄ panels.
import { h2 } from './noise.js';
import { loadAtlas, loadDistricts, loadSubdistricts } from './data.js';
import { classifyCells, renderWorld, LAYERS } from './world.js';
import { createView3D } from './view3d.js';
import { renderBackdrop, TileLayer, Countries } from './backdrop.js';

import { buildDistrictLayer } from './districts.js';
import { MapView } from './mapView.js';
import { Inventory } from './inventory.js';
import { ProvincePanel } from './panel.js';
import { Tooltip, provinceTip, districtTip, areaTip, esc, renderF3, renderCredits } from './ui.js';
import { railTile, N, S, makeBlockAtlas } from './pieces.js';
import { spriteFromRows } from './sprites.js';

const $ = id => document.getElementById(id);

paintDirtBackground();
renderCredits($('credits'));

const loading = $('loading');
let atlas;
try {
  atlas = await loadAtlas((done, total) => {
    $('loadBar').style.width = `${Math.round(done / total * 100)}%`;
    $('loadMsg').textContent = `Loading provinces ${done}/${total}`;
  });
} catch (err) {
  $('loadMsg').innerHTML = location.protocol === 'file:'
    ? 'This page loads its data with fetch(), which browsers block for file:// pages.<br>Run <code>python3 -m http.server</code> in the project folder and open <code>http://localhost:8000</code>.'
    : `Could not load map data: ${err.message}`;
  throw err;
}
$('loadMsg').textContent = 'Generating terrain…';
await new Promise(r => requestAnimationFrame(() => setTimeout(r)));
const cells = classifyCells(atlas);
const layers = loadLayers();
let world = renderWorld(atlas, cells, layers);
loading.hidden = true;

const { provinces } = atlas;
const tooltip = new Tooltip($('tip'));
let selected = -1;
let layer = null;
let areaSelected = null;    // selected state / region of another detailed country

const handlers = {
  onHover(pick, e) {
    renderF3($('f3'), atlas, pick, layer);
    panel.highlightDistrict(pick && layer && pick.province === selected ? pick.district : -1);
    if (pick?.detail && e.pointerType === 'mouse') return tooltip.show(areaTip(pick.detail, 'Click to inspect'), e.clientX, e.clientY);
    if (!pick || pick.province < 0 || e.pointerType !== 'mouse') return tooltip.hide();
    const p = provinces[pick.province];
    if (layer && pick.province === selected && pick.district >= 0) {
      tooltip.show(districtTip(p, layer.districts[pick.district], 'Click to list tambon'), e.clientX, e.clientY);
    } else {
      tooltip.show(provinceTip(p, 'Click to inspect'), e.clientX, e.clientY);
    }
  },
  onClick(pick) {
    if (pick.detail) return selectArea(pick.detail.area, false);
    if (pick.province === selected && layer && pick.district >= 0) selectDistrict(pick.district, false);
    else select(pick.province, false);
  },
};
// low-detail backdrops, drawn world first, then the ASEAN region on top
const backdrops = [atlas.world, atlas.asean].filter(Boolean).map(b => ({ data: b, canvas: renderBackdrop(b) }));
const countries = new Countries(atlas.map);
const tiles = new TileLayer(atlas.map, countries);
const map = new MapView({ canvas: $('map'), wrap: $('mapWrap'), atlas, world, backdrops, tiles, cells, ...handlers });
tiles.onLoad = () => { map.dirty = true; };
// detailed tiles and the other detailed countries are optional (not in the artifact)
countries.init().then(() => tiles.init()).then(() => { tiles.setLayers(layers); map.dirty = true; buildCountryTabs(); });
makeBlockAtlas().then(b => map.setBlockAtlas(b)).catch(() => {});   // textures for the close-up 2D view
map.layers = { ...layers };
let view3d = null;   // created on first switch to 3D
let mode = '2d';
const active = () => (mode === '3d' ? view3d : map);

const inventory = new Inventory({
  tabsEl: $('tabs'), gridEl: $('grid'), searchEl: $('q'), titleEl: $('invTitle'), countEl: $('invCount'),
  provinces, tooltip,
  onSelect: i => select(i),
  onHover: i => { map.setHover(i); view3d?.setHover(i); },
});

const panel = new ProvincePanel($('selPanel'), {
  provinces,
  onSelect: i => select(i),
  onFly: i => active().focusProvince(i),
  onDistrict: k => selectDistrict(k, true),
  onDistrictHover: k => map.setDistrictHover(k),
});

async function select(i, fly = true) {
  clearArea();
  selected = i;
  layer = null;
  const p = provinces[i];
  map.setSelected(i);
  view3d?.setSelected(i);
  inventory.setSelected(i);
  panel.show(p);
  renderF3($('f3'), atlas, null, null);
  if (fly) active().focusProvince(i);
  try {
    const [d, subs] = await Promise.all([loadDistricts(p.slug), loadSubdistricts(p.slug)]);
    if (selected !== i) return;
    layer = buildDistrictLayer(d, atlas.map);
    map.setDistrictLayer(layer);
    view3d?.setDistrictLayer(layer);
    panel.setDistricts(p, d, subs);
  } catch (err) {
    panel.setError(p, `Could not load districts: ${err.message}`);
  }
}

function selectDistrict(k, fly) {
  map.setDistrictFocus(k);
  view3d?.setDistrictFocus(k);
  panel.openDistrict(k);
  if (fly) active().focusDistrict(k);
}

$('zin').onclick = () => mode === '3d' ? view3d.zoom(1.5) : map.zoomAt(1.5, map.cw / 2, map.ch / 2);
$('zout').onclick = () => mode === '3d' ? view3d.zoom(1 / 1.5) : map.zoomAt(1 / 1.5, map.cw / 2, map.ch / 2);
$('zfit').onclick = () => mode === '3d' ? view3d.fit() : map.goTo(map.fitView());

/* ---------- 2D / 3D switch ---------- */
const V_SCALES = [25, 40, 80];    // metres of real elevation per block
$('mode').onclick = async () => {
  const btn = $('mode');
  if (mode === '2d') {
    if (!view3d) {
      btn.disabled = true; btn.textContent = 'Loading…';
      try {
        view3d = await createView3D({ canvas: $('map3d'), wrap: $('mapWrap'), atlas, cells, world, backdrops, ...handlers });
      } catch (err) {
        btn.disabled = false; btn.textContent = '3D';
        $('hint').textContent = `3D view unavailable: ${err.message}`;
        return;
      }
      btn.disabled = false;
      view3d.setSelected(selected);
      view3d.setLayers(layers);
      if (layer) view3d.setDistrictLayer(layer);
    }
    mode = '3d';
    $('map').hidden = true; $('map3d').hidden = false; $('vscale').hidden = false;
    btn.textContent = '2D'; btn.setAttribute('aria-label', 'Switch to 2D map');
    $('hint').textContent = 'Drag to orbit · right-drag or shift-drag to pan · scroll to zoom';
    view3d.setActive(true);
    if (selected >= 0) view3d.focusProvince(selected);
  } else {
    mode = '2d';
    view3d.setActive(false);
    $('map3d').hidden = true; $('map').hidden = false; $('vscale').hidden = true;
    btn.textContent = '3D'; btn.setAttribute('aria-label', 'Switch to 3D view');
    $('hint').textContent = 'Drag to pan · scroll to zoom · click a province, then a district';
    map.dirty = true;
  }
  tooltip.hide();
};
$('vscale').onclick = () => {
  const i = (V_SCALES.indexOf(view3d.metresPerBlock) + 1) % V_SCALES.length;
  view3d.setVerticalScale(V_SCALES[i]);
  $('vscale').textContent = `${V_SCALES[i]} m/block`;
};
document.addEventListener('keydown', e => { if (e.key === 'Escape') tooltip.hide(); });
if (document.fonts) document.fonts.ready.then(() => { map.dirty = true; });

select(provinces.findIndex(p => p.slug === 'bangkok'), false);

// small handle for tools/screenshot.py and debugging in the console
window.atlasApp = { map, tiles, countries, select, selectArea, showCountry };

/* ---------- other detailed countries (Sprint 2 on) ---------- */
function selectArea(area, fly = true) {
  areaSelected = area;
  selected = -1; layer = null;
  map.setSelected(-1);
  map.foreignSelected = area;
  tiles.setSelected({ country: area.country, area });
  map.dirty = true;
  panel.showArea(area, { onArea: a => selectArea(a), onFly: a => map.focusArea(a) });
  if (fly) map.focusArea(area);
}
function clearArea() {
  if (!areaSelected) return;
  areaSelected = null;
  map.foreignSelected = null;
  tiles.setSelected(null);
  map.dirty = true;
}
/** Country picker above the inventory: Thailand's provinces or another country's areas. */
function buildCountryTabs() {
  const bar = $('countryTabs');
  if (!countries.list.length) { bar.hidden = true; return; }
  bar.hidden = false;
  const all = [{ code: 'THA', name: { en: 'Thailand' } }, ...countries.list];
  bar.innerHTML = all.map(c => `<button class="ctab" data-c="${c.code}" aria-pressed="${c.code === 'THA'}">${esc(c.name.en)}</button>`).join('');
  bar.querySelectorAll('.ctab').forEach(b => b.onclick = () => {
    bar.querySelectorAll('.ctab').forEach(x => x.setAttribute('aria-pressed', x === b));
    showCountry(b.dataset.c);
  });
}
function showCountry(code) {
  const thai = code === 'THA';
  $('tabs').hidden = !thai;
  $('q').hidden = !thai;
  if (thai) { inventory.render(); return; }
  const c = countries.list.find(x => x.code === code);
  $('invTitle').textContent = `${c.name.en} · ${c.areas.length} ${c.term}s`;
  $('invCount').textContent = '';
  const grid = $('grid');
  grid.innerHTML = '';
  const total = Math.max(27, Math.ceil(c.areas.length / 9) * 9);
  for (let n = 0; n < total; n++) {
    const a = c.areas[n];
    const s = document.createElement(a ? 'button' : 'div');
    s.className = 'slot';
    if (a) {
      s.setAttribute('aria-label', `${a.name.en}: ${a.item.name}`);
      s.innerHTML = `<img src="${spriteFromRows(`c:${c.code}:${a.id}`, a.item.sprite).url}" alt="">`;
      s.onclick = () => selectArea(a);
      s.onmouseenter = e => tooltip.show(`<div class="t-name">${esc(a.name.en)}</div><div class="t-th">${esc(c.name.en)}</div><div class="t-item">✦ ${esc(a.item.name)}</div>`, e.clientX, e.clientY);
      s.onmouseleave = () => tooltip.hide();
    }
    grid.appendChild(s);
  }
}

/* ---------- map layers ---------- */
$('railIcon').style.backgroundImage = `url(${railTile(N | S).toDataURL()})`;
function loadLayers() {
  try { return { ...LAYERS, ...JSON.parse(localStorage.getItem('layers') || '{}') }; } catch { return { ...LAYERS }; }
}
document.querySelectorAll('#layers input').forEach(box => {
  box.checked = layers[box.name];
  box.addEventListener('change', () => {
    layers[box.name] = box.checked;
    try { localStorage.setItem('layers', JSON.stringify(layers)); } catch { /* per-viewer convenience only */ }
    $('layers').classList.add('busy');
    // let the "busy" state paint before the ~0.5 s redraw
    requestAnimationFrame(() => setTimeout(() => {
      world = renderWorld(atlas, cells, layers, world);
      map.layers = { ...layers };
      map.dirty = true;
      view3d?.setLayers(layers);
      tiles.setLayers(layers);
      $('layers').classList.remove('busy');
    }));
  });
});

/** Minecraft options-screen dirt texture behind the page. */
function paintDirtBackground() {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const x = c.getContext('2d');
  const cols = ['#866043', '#593d29', '#79553a', '#6b4a30', '#966c4a'];
  for (let i = 0; i < 256; i++) {
    x.fillStyle = cols[Math.floor(h2(i % 16, i >> 4, 99) * cols.length)];
    x.fillRect(i % 16, i >> 4, 1, 1);
  }
  x.fillStyle = 'rgba(0,0,0,.66)';
  x.fillRect(0, 0, 16, 16);
  document.body.style.backgroundImage = `url(${c.toDataURL()})`;
}
