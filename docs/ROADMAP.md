# Roadmap: every ASEAN country (plus Hong Kong and Macau) at Thailand's level of detail

Today only Thailand is detailed (550 m blocks, provinces, districts, OTOP items, roads, rails,
rivers, textured 3D). The rest of ASEAN is a 5.5 km backdrop. The rest of the world is shown
too, but only as a low-detail backdrop; detail is for ASEAN, Hong Kong and Macau. Bringing every country to the same
level is too big for one change, so it is split into sprints that ship one after another. Each
sprint ends working, committed, pushed and announced on Discord.

Countries: Myanmar, Laos, Cambodia, Vietnam, Malaysia, Singapore, Brunei, Indonesia,
Philippines, Timor-Leste, Hong Kong, Macau (and Thailand).

| Sprint | Goal | Status |
| --- | --- | --- |
| 1 | **World + tiled ASEAN**: the whole world as a low-detail backdrop (~27 km blocks, real terrain, every country); ASEAN, Hong Kong and Macau at 550 m blocks in 2° tiles that stream in as you pan and zoom (land/sea, country, real elevation). Thailand's current map keeps working on top. | done |
| 2 | **Admin areas**: provinces/states and districts for every country (geoBoundaries, incl. Hong Kong and Macau), country picker, same province/district panel as Thailand. | planned |
| 3 | **Roads, railways, rivers, lakes** for every country from OpenStreetMap (Geofabrik extracts), same layers and styles as Thailand. | planned |
| 4 | **3D everywhere**: 3D chunks stream from the tiles, with textures and levels of detail, for the whole region. | planned |
| 5 | **Iconic items, part 1**: hand-made pixel items for every province/state of Myanmar, Laos, Cambodia, Vietnam. | planned |
| 6 | **Iconic items, part 2**: Malaysia, Singapore, Brunei, Philippines, Timor-Leste, Hong Kong, Macau. | planned |
| 7 | **Iconic items, part 3**: Indonesia (38 provinces). | planned |
| 8 | **Local products**: district items like Thailand's OTOP where open data exists (e.g. Philippines OTOP, Vietnam OCOP); terrain-based items elsewhere. | planned |

## Hosting note

A tiled world is hundreds of files. The claude.ai artifact allows at most 255 files, so from
Sprint 1 the full map is meant to be served from GitHub Pages (or any static host); the artifact
keeps a Thailand-focused version.
