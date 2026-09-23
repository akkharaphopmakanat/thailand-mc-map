# thailand-mc-map

Made by [akkharaphopmakanat](https://github.com/akkharaphopmakanat/).

A Minecraft-style block map of Thailand and ASEAN. The whole world is shown as a low-detail
backdrop; ASEAN, Hong Kong and Macau get 550 m blocks (streamed in 2° tiles), and Thailand has
the full treatment below. See [docs/ROADMAP.md](docs/ROADMAP.md) for the sprints bringing every
ASEAN country up to Thailand's level. Each of the 77 provinces has its own
pixel-art "iconic item", and you can drill down from a province to its
districts (อำเภอ / เขต), each with its own item, and sub-districts (ตำบล / แขวง).
Roads, railways and rivers come from OpenStreetMap. **Main roads** (motorway, trunk) are stone
blocks and **medium roads** (primary, secondary) are dirt path; roads over water become oak-plank
bridges. Zoom in and railways become connected Minecraft rail pieces: straights, curves and
buffer stops, plus a special **rail junction block** (a gravel pad with the branching track and a
switch lever) where lines meet. River names sit on the main rivers themselves. A **Layers** box
switches main roads, medium roads, railways, main rivers and small rivers on and off. Switch to the **3D** view to fly over real terrain built from
elevation data.

## Hosting

The full map streams hundreds of tile files, so host it as a static site, e.g. GitHub Pages:
repository **Settings → Pages → Deploy from a branch → `main` / root**. (The claude.ai artifact
holds a Thailand-focused version without the tiles; it still shows the world and ASEAN backdrops.)

## Run it

The page loads its data with `fetch()`, so serve the folder over HTTP rather than
opening `index.html` directly:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Layout

```
index.html                  page shell
css/style.css               Minecraft GUI styles
js/
  main.js                   entry point: loads data, wires map ⇄ panels
  config.js                 sprite palette, regions/biomes, map labels
  data.js                   loads map.json and per-province files (districts lazily)
  rle.js                    decoder for the run-length-encoded rasters
  noise.js                  hash / value noise for terrain
  world.js                  classifies blocks (shared by 2D/3D) and renders the 2D terrain
  districts.js              builds the district layer for a selected province
  mapView.js                2D canvas camera, pan/zoom/pinch, picking, drawing
  view3d.js                 3D voxel view in chunks with 3 levels of detail (three.js from cdnjs, loaded on demand)
  sprites.js                16×16 item sprite → canvas / data URL
  pieces.js                 rail pieces, junction block, block texture atlas + shader, block→texture rule
  inventory.js              creative-inventory grid with region tabs and search
  panel.js                  selected province card + district/tambon browser
  ui.js                     Minecraft tooltip, F3 debug overlay, credits panel (from data/sources.json)
  backdrop.js               world + ASEAN backdrops, streamed detailed tiles, other detailed countries
  textures.js               block textures as data URLs [generated from assets/textures]
data/
  sources.json              data references and credits
  blocks.json               per-block roads, rails, rivers (OSM), river labels, lakes  [generated]
  asean_elevation.png       ASEAN backdrop elevation (backdrop grid itself is in map.json)  [generated]
  world_elevation.png       world backdrop elevation (grid in map.json 'world')        [generated]
  tiles/<tx>_<ty>.png       detailed 550 m tiles for ASEAN / HK / Macau: elevation + country  [generated]
  tiles/index.json          tile list and country table                                [generated]
  tiles/<tx>_<ty>.a.png     per-tile layers for detailed countries: district, road, water  [generated]
  countries/<ISO>/areas.json  iconic item per state / region (hand-written)             [hand-written]
  countries/<ISO>.json      areas, items, label points, districts                      [generated]
  elevation.png             real mean elevation / sea depth per block (R*256+G-32768)   [generated]
  sprites.json              shared 16×16 sprites for district items                   [hand-written]
  map.json                  Thai block grid (0.005° ≈ 550 m), anchors, neighbours, ASEAN + world backdrops  [generated]
  provinces/<slug>/
    province.json           name, region, item + sprite, description, district_items  [hand-written]
    districts.json          district raster, names and each district's item           [generated]
    subdistricts.json       tambon names + postcodes, keyed by district id            [generated]
tools/build_data.py         regenerates the [generated] files (Thailand, backdrops, tiles)
tools/build_countries.py    brings other countries up to Thailand's level (areas, districts, OSM layers)
tools/screenshot.py         headless Chrome screenshots of the page
```

## Editing a province

Change `data/provinces/<slug>/province.json`. The `item.sprite` is 16 rows of 16
characters; each letter is a colour from `PAL` in `js/config.js` and `.` is
transparent.

District icons come from **OTOP** (One Tambon One Product) data: rated products from the
Community Development Department's OTOP Product Champion list are linked to districts
through the OTOP producer register, sorted into product types by keywords in their Thai
names (กล้วยตาก → Dried Banana, ผ้าไหม → Silk, กาแฟ → Coffee…, see `OTOP_TYPES` in
`tools/build_data.py`), and each district shows its most distinctive type, weighted by
star rating and by how rare that type is nationwide. Bang Krathum, for example, shows
Dried Banana. Only product names, types and stars are published, never producer names.

Hand-picked landmarks are shown alongside the OTOP item. Add one under `district_items`
in the province file, keyed by the district's English name as it appears in `districts.json`:

```json
"district_items": {
  "Chom Thong": { "item": "Doi Inthanon", "sprite": "mountain", "note": "Thailand's highest peak." }
}
```

`sprite` is any id from `data/sprites.json` or any province's `item.id`. The few
districts with no rated OTOP products use their landmark, or else an item chosen from
their real average elevation, coastline and region.

## Other countries

Countries are brought up to Thailand's level one sprint at a time (see
[docs/ROADMAP.md](docs/ROADMAP.md)). So far: **Malaysia** (16 states, 159 districts),
**Singapore** (5 regions, 55 planning areas) and **Brunei** (4 districts, 38 mukims), each with
an iconic item per state / region / district, borders, roads, railways, rivers and lakes. Pick
a country above the inventory; hover or click the map to inspect.

Hand-written items live in `data/countries/<ISO>/areas.json` (keyed by the geoBoundaries ADM1
name). Build a country group with:

```sh
python3 tools/build_countries.py MYS SGP BRN
```

It writes `data/countries/<ISO>.json`, `data/countries/index.json` and per-tile layers
`data/tiles/<tx>_<ty>.a.png` (district id, road / railway / river / lake codes).

`tools/screenshot.py` captures the page in headless Chrome (optionally after running some
JavaScript against `window.atlasApp`), handy for release notes.

## Rebuilding the data

```sh
python3 tools/build_data.py
```

The first run downloads the source datasets into `tools/.cache/` (git-ignored; about
0.5 GB including the OpenStreetMap extract and elevation tiles). Reading OpenStreetMap
needs pyosmium, installed next to the cache:

```sh
pip install --target tools/.cache/pylib osmium
```

It never touches `province.json`.

## Credits

Created by **[akkharaphopmakanat](https://github.com/akkharaphopmakanat/)**.

### Data references

All references are also kept machine-readable in [`data/sources.json`](data/sources.json),
which the page's Credits panel is built from.

| Data | Source | License | Used for |
| --- | --- | --- | --- |
| Province boundaries | [apisit/thailand.json](https://github.com/apisit/thailand.json) | none stated | Province outlines (`data/map.json`) |
| District boundaries | [geoBoundaries](https://www.geoboundaries.org/) THA ADM2, gbOpen — Royal Thai Survey Department / OCHA ROAP | CC BY 3.0 IGO | District outlines (`districts.json`) |
| District and sub-district names, postcodes | [kongvut/thai-province-data](https://github.com/kongvut/thai-province-data) by Kongvut Sangkla | MIT | Names and postcodes (`districts.json`, `subdistricts.json`) |
| Reservoirs | [Natural Earth](https://www.naturalearthdata.com/) 1:10m lakes | public domain | `rivers.json`: reservoirs |
| Neighbouring countries | [Natural Earth](https://www.naturalearthdata.com/) 1:50m countries | public domain | Land vs sea outside Thailand |
| Roads, railways, small rivers | © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, via [Geofabrik](https://download.geofabrik.de/asia/thailand.html) | ODbL 1.0 | `blocks.json` (derived database, same licence) |
| OTOP products | [Community Development Department](https://data.go.th/dataset/cdd_opc) OTOP Product Champion list and producer register | Open Data Common | District OTOP items (`districts.json`) |
| Elevation and sea depth | [Terrain Tiles on AWS](https://registry.opendata.aws/terrain-tiles/) (Mapzen terrarium; SRTM, GMTED, ETOPO1 and others) | public, attribution required | `elevation.png`, 2D relief, 3D view |

geoBoundaries citation: Runfola, D. et al. (2020) *geoBoundaries: A global database of
political administrative boundaries.* PLoS ONE 15(4): e0231866.
https://doi.org/10.1371/journal.pone.0231866

Fonts (SIL Open Font License 1.1): Press Start 2P, Pixelify Sans, Kanit.

Sub-districts are names and postcodes only; there is no open, lightweight
tambon boundary dataset, so tambon are listed rather than drawn. Three named
districts have no outline in the boundary data (Ko Sichang, and two entries in
Ratchaburi and Songkhla), so they are listed but not drawn.

Elevation is real but averaged over 550 m blocks; trees and paddies are generated
for looks. Province items, sprites and descriptions are original to this project.
The 3D view loads [three.js](https://threejs.org/) r128 (MIT) from cdnjs.

*Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.*
