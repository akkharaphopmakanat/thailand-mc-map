# thailand-mc-map

Made by [akkharaphopmakanat](https://github.com/akkharaphopmakanat/).

A Minecraft-style block map of Thailand. Each of the 77 provinces has its own
pixel-art "iconic item", and you can drill down from a province to its
districts (อำเภอ / เขต), each with its own item, and sub-districts (ตำบล / แขวง).
Highways are drawn as stone paths and smaller roads as dirt paths (with oak-plank
bridges over water). Switch to the **3D** view to fly over real terrain built from
elevation data.

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
  view3d.js                 3D voxel view (three.js from cdnjs, loaded on demand)
  sprites.js                16×16 item sprite → canvas / data URL
  inventory.js              creative-inventory grid with region tabs and search
  panel.js                  selected province card + district/tambon browser
  tooltip.js                Minecraft item tooltip
  credits.js                Credits panel built from data/sources.json
  f3.js                     F3 debug overlay (lat/lon, biome, province, district)
data/
  sources.json              data references and credits
  roads.json                highways / roads as world-pixel polylines                  [generated]
  elevation.json            real mean elevation / sea depth per block (int16, base64)   [generated]
  sprites.json              shared 16×16 sprites for district items                   [hand-written]
  map.json                  country block grid (0.02° ≈ 2.2 km), anchors, neighbours  [generated]
  provinces/<slug>/
    province.json           name, region, item + sprite, description, district_items  [hand-written]
    districts.json          district raster, names and each district's item           [generated]
    subdistricts.json       tambon names + postcodes, keyed by district id            [generated]
tools/build_data.py         regenerates the [generated] files
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

## Rebuilding the data

```sh
python3 tools/build_data.py
```

The first run downloads the source datasets into `tools/.cache/` (git-ignored).
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
| Roads | [Natural Earth](https://www.naturalearthdata.com/) 1:10m roads | public domain | `roads.json`: highways as stone paths, roads as dirt paths |
| OTOP products | [Community Development Department](https://data.go.th/dataset/cdd_opc) OTOP Product Champion list and producer register | Open Data Common | District OTOP items (`districts.json`) |
| Elevation and sea depth | [Terrain Tiles on AWS](https://registry.opendata.aws/terrain-tiles/) (Mapzen terrarium; SRTM, GMTED, ETOPO1 and others) | public, attribution required | `elevation.json`, 2D relief, 3D view |

geoBoundaries citation: Runfola, D. et al. (2020) *geoBoundaries: A global database of
political administrative boundaries.* PLoS ONE 15(4): e0231866.
https://doi.org/10.1371/journal.pone.0231866

Fonts (SIL Open Font License 1.1): Press Start 2P, Pixelify Sans, Kanit.

Sub-districts are names and postcodes only; there is no open, lightweight
tambon boundary dataset, so tambon are listed rather than drawn. Three named
districts have no outline in the boundary data (Ko Sichang, and two entries in
Ratchaburi and Songkhla), so they are listed but not drawn.

Elevation is real but averaged over 2.2 km blocks; trees and paddies are generated
for looks. Province items, sprites and descriptions are original to this project.
The 3D view loads [three.js](https://threejs.org/) r128 (MIT) from cdnjs.

*Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.*
