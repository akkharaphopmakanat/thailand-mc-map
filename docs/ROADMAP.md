# Roadmap: every ASEAN country (plus Hong Kong and Macau) at Thailand's level of detail

Thailand was built first, with everything: provinces and districts, iconic items, OTOP district
items, roads, railways, rivers, lakes and a textured 3D view. Sprint 1 gave the rest of ASEAN,
Hong Kong and Macau the same 550 m terrain (streamed 2° tiles), and the rest of the world a
low-detail backdrop. The remaining sprints bring the other countries up to Thailand's level
**one country (or a small group) at a time**. Each sprint ends working, committed, pushed and
announced on Discord, and the next one starts only after that.

What "Thailand level" means for each country:

- first-level areas (states / provinces / regions) and districts, with a country picker and the
  same selection panel, tooltips and borders as Thailand; each district with its own item, a
  landmark and its place names (Sprint 2b);
- an iconic pixel item for every first-level area, on the map and in the inventory;
- roads (main / medium), railways with Minecraft rail pieces, main and small rivers, lakes;
- the textured 3D view.

| Sprint | Countries / goal | Areas | Status |
| --- | --- | --- | --- |
| 1 | World backdrop + 550 m terrain tiles for all ASEAN, Hong Kong, Macau | — | done |
| 2 | **Malaysia, Singapore, Brunei** + the shared engine: per-tile districts, roads, rails, rivers, lakes; country picker; iconic items | 16 states, 5 regions, 4 districts | done |
| 2b | **District level** for Malaysia, Singapore, Brunei, plus **Hong Kong** and **Macau** (pulled forward from Sprint 9): district rasters finer than the blocks, an item and landmark per district, place names, district panel | 279 districts / planning areas / mukims / parishes | done |
| 3 | **3D everywhere**: 3D chunks stream from the tiles, textured, for every country done so far and every one after | — | planned |
| 4 | **Vietnam** | 63 provinces | planned |
| 5 | **Laos** and **Cambodia** | 18 + 25 provinces | planned |
| 6 | **Myanmar** | 14 states / regions | planned |
| 7 | **Philippines** | 17 regions | planned |
| 8 | **Indonesia** | 34 provinces | planned |
| 9 | **Timor-Leste** (Hong Kong and Macau were done in Sprint 2b) | 13 | planned |
| 10 | Local products for districts where open data exists (Vietnam OCOP, Philippines OTOP, …), polish | — | planned |

Boundaries come from geoBoundaries (ADM1/ADM2, various open licences, credited per country);
roads, railways, rivers and lakes from OpenStreetMap (Geofabrik extracts, ODbL).

## Hosting note

The tiles are hundreds of files. The claude.ai artifact allows at most 255 files, so the full map
is served from a static host (Cloudflare or GitHub Pages); the artifact keeps a Thailand-focused
version with the world and ASEAN backdrops.
