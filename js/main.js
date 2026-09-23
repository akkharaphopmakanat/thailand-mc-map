// Entry point: load data, build the world, and wire map ⇄ panels.
import { h2 } from './noise.js';
import { loadAtlas, loadDistricts, loadSubdistricts } from './data.js';
import { renderWorld } from './world.js';
import { buildDistrictLayer } from './districts.js';
import { MapView } from './mapView.js';
import { Inventory } from './inventory.js';
import { ProvincePanel } from './panel.js';
import { Tooltip, provinceTip, districtTip } from './tooltip.js';
import { renderF3 } from './f3.js';
import { renderCredits } from './credits.js';

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
const world = renderWorld(atlas);
loading.hidden = true;

const { provinces } = atlas;
const tooltip = new Tooltip($('tip'));
let selected = -1;
let layer = null;

const map = new MapView({
  canvas: $('map'), wrap: $('mapWrap'), atlas, world,
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
});

const inventory = new Inventory({
  tabsEl: $('tabs'), gridEl: $('grid'), searchEl: $('q'), titleEl: $('invTitle'), countEl: $('invCount'),
  provinces, tooltip,
  onSelect: i => select(i),
  onHover: i => map.setHover(i),
});

const panel = new ProvincePanel($('selPanel'), {
  provinces,
  onSelect: i => select(i),
  onFly: i => map.focusProvince(i),
  onDistrict: k => selectDistrict(k, true),
  onDistrictHover: k => map.setDistrictHover(k),
});

async function select(i, fly = true) {
  selected = i;
  layer = null;
  const p = provinces[i];
  map.setSelected(i);
  inventory.setSelected(i);
  panel.show(p);
  renderF3($('f3'), atlas, null, null);
  if (fly) map.focusProvince(i);
  try {
    const [d, subs] = await Promise.all([loadDistricts(p.slug), loadSubdistricts(p.slug)]);
    if (selected !== i) return;
    layer = buildDistrictLayer(d, atlas.map);
    map.setDistrictLayer(layer);
    panel.setDistricts(p, d, subs);
  } catch (err) {
    panel.setError(p, `Could not load districts: ${err.message}`);
  }
}

function selectDistrict(k, fly) {
  map.setDistrictFocus(k);
  panel.openDistrict(k);
  if (fly) map.focusDistrict(k);
}

$('zin').onclick = () => map.zoomAt(1.5, map.cw / 2, map.ch / 2);
$('zout').onclick = () => map.zoomAt(1 / 1.5, map.cw / 2, map.ch / 2);
$('zfit').onclick = () => map.goTo(map.fitView());
document.addEventListener('keydown', e => { if (e.key === 'Escape') tooltip.hide(); });
if (document.fonts) document.fonts.ready.then(() => { map.dirty = true; });

select(provinces.findIndex(p => p.slug === 'bangkok'), false);

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
