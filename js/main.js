// Entry point: load data, build the world, and wire map ⇄ panels.
import { h2 } from './noise.js';
import { loadAtlas, loadDistricts, loadSubdistricts } from './data.js';
import { classifyCells, renderWorld, LAYERS } from './world.js';
import { createView3D } from './view3d.js';
import { renderAsean } from './asean.js';
import { buildDistrictLayer } from './districts.js';
import { MapView } from './mapView.js';
import { Inventory } from './inventory.js';
import { ProvincePanel } from './panel.js';
import { Tooltip, provinceTip, districtTip, renderF3, renderCredits } from './ui.js';
import { railTile, N, S, makeBlockAtlas } from './pieces.js';

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

const handlers = {
  onHover(pick, e) {
    renderF3($('f3'), atlas, pick, layer);
    panel.highlightDistrict(pick && layer && pick.province === selected ? pick.district : -1);
    if (!pick || pick.province < 0 || e.pointerType !== 'mouse') return tooltip.hide();
    const p = provinces[pick.province];
    if (layer && pick.province === selected && pick.district >= 0) {
      tooltip.show(districtTip(p, layer.districts[pick.district], 'Click to list tambon'), e.clientX, e.clientY);
    } else {
      tooltip.show(provinceTip(p, 'Click to inspect'), e.clientX, e.clientY);
    }
  },
  onClick(pick) {
    if (pick.province === selected && layer && pick.district >= 0) selectDistrict(pick.district, false);
    else select(pick.province, false);
  },
};
const backdrop = atlas.asean ? renderAsean(atlas.asean) : null;
const map = new MapView({ canvas: $('map'), wrap: $('mapWrap'), atlas, world, backdrop, cells, ...handlers });
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
        view3d = await createView3D({ canvas: $('map3d'), wrap: $('mapWrap'), atlas, cells, world, backdrop, ...handlers });
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
