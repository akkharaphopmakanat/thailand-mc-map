# thailand-mc-map

A Minecraft-style block map of Thailand. Each of the 77 provinces has its own
pixel-art "iconic item", and you can drill down from a province to its
districts (อำเภอ / เขต) and sub-districts (ตำบล / แขวง).

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
  world.js                  renders the terrain canvas and province paths
  districts.js              builds the district layer for a selected province
  mapView.js                canvas camera, pan/zoom/pinch, picking, drawing
  sprites.js                16×16 item sprite → canvas / data URL
  inventory.js              creative-inventory grid with region tabs and search
  panel.js                  selected province card + district/tambon browser
  tooltip.js                Minecraft item tooltip
  f3.js                     F3 debug overlay (lat/lon, biome, province, district)
data/
  map.json                  country block grid (0.04° ≈ 4.4 km), anchors, neighbours  [generated]
  provinces/<slug>/
    province.json           name, region, item name + sprite, description             [hand-written]
    districts.json          district raster + Thai/English names                      [generated]
    subdistricts.json       tambon names + postcodes, keyed by district id            [generated]
tools/build_data.py         regenerates the [generated] files
```

## Editing a province

Change `data/provinces/<slug>/province.json`. The `item.sprite` is 16 rows of 16
characters; each letter is a colour from `PAL` in `js/config.js` and `.` is
transparent.

## Rebuilding the data

```sh
python3 tools/build_data.py
```

The first run downloads the source datasets into `tools/.cache/` (git-ignored).
It never touches `province.json`.

## Data sources

- Province outlines: [apisit/thailand.json](https://github.com/apisit/thailand.json)
- District outlines: [geoBoundaries THA ADM2](https://www.geoboundaries.org/) — Royal Thai Survey Department / OCHA ROAP, CC BY 3.0 IGO
- District and sub-district names, postcodes: [kongvut/thai-province-data](https://github.com/kongvut/thai-province-data) — MIT

Sub-districts are names and postcodes only; there is no open, lightweight
tambon boundary dataset, so tambon are listed rather than drawn. Three named
districts have no outline in the boundary data (Ko Sichang, and two entries in
Ratchaburi and Songkhla), so they are listed but not drawn.
