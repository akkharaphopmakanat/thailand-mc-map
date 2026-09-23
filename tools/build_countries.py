#!/usr/bin/env python3
"""Bring other countries up to Thailand's level of detail, one group at a time.

For each country group (see GROUPS) this reads:
  - geoBoundaries ADM1 / ADM2 polygons (downloaded to tools/.cache/gb_<ISO>_<ADM>.geojson)
  - data/countries/<ISO>/areas.json: hand-written iconic item per first-level area
  - the group's OpenStreetMap extract (Geofabrik), for roads, railways, rivers and lakes
and writes:
  - data/tiles/<tx>_<ty>.a.png   per-tile layers, RGB: district = R * 256 + G (1-based, within the
                                 block's country from the base tile), B = road | water << 3
                                 (road: 2–3 medium, 4 main, 5 railway; water: 1 small, 2 main
                                 river, 3 lake). Cells of other countries are kept as they were.
  - data/countries/<ISO>.json    areas (name, item + sprite, lore, label point) and districts
  - data/countries/index.json    countries with detail so far

Usage: python3 tools/build_countries.py MYS SGP BRN
"""
import json, math, os, sys, urllib.request
from collections import deque

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_data as bd                    # shared helpers: raster_spans, polygons, bbox, dump, S, …

GROUPS = {                                 # country -> Geofabrik extract that covers it
    'MYS': 'malaysia-singapore-brunei', 'SGP': 'malaysia-singapore-brunei', 'BRN': 'malaysia-singapore-brunei',
}
GEOFABRIK = 'https://download.geofabrik.de/asia/{}-latest.osm.pbf'
N = round(bd.TILE_DEG / bd.S)              # blocks per tile side (400)
MAIN_RIVER_KM = 80                         # a named river this long (all its pieces) counts as main


def geoboundaries(iso, level):
    path = os.path.join(bd.CACHE, f'gb_{iso}_{level}.geojson')
    if not os.path.exists(path):
        meta = json.load(urllib.request.urlopen(f'https://www.geoboundaries.org/api/current/gbOpen/{iso}/{level}/'))
        urllib.request.urlretrieve(meta['simplifiedGeometryGeoJSON'], path)
    with open(path, encoding='utf-8') as f:
        return json.load(f)['features']


def point_in_poly(x, y, polys):
    inside = False
    for poly in polys:
        for ring in poly:
            for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
                if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
                    inside = not inside
    return inside


def load_tile(key):
    """Base tile (elevation + country) as numpy arrays."""
    import numpy as np
    from PIL import Image
    a = np.asarray(Image.open(os.path.join(bd.DATA, 'tiles', key + '.png')).convert('RGB'))
    return a[..., 2].copy()


def build(isos):
    import numpy as np
    from PIL import Image
    index = json.load(open(os.path.join(bd.DATA, 'tiles', 'index.json')))
    cidx = {c['code']: i + 1 for i, c in enumerate(index['countries'])}      # tile country value per ISO
    lon0, lat1 = index['lon0'], index['lat1']
    tiles = [tuple(t) for t in index['tiles']]
    base = {}                                                                 # key -> country grid
    layers = {}                                                               # key -> (district u16, road u8, water u8)

    def tile_of(key):
        if key not in layers:
            base[key] = load_tile(key)
            path = os.path.join(bd.DATA, 'tiles', key + '.a.png')
            if os.path.exists(path):
                a = np.asarray(Image.open(path).convert('RGB')).astype(np.int32)
                layers[key] = [(a[..., 0] << 8) | a[..., 1], a[..., 2] & 7, a[..., 2] >> 3]
            else:
                layers[key] = [np.zeros((N, N), np.int32), np.zeros((N, N), np.int32), np.zeros((N, N), np.int32)]
        return layers[key]

    mine = {cidx[i] for i in isos}
    for iso in isos:
        c = cidx[iso]
        areas_file = json.load(open(os.path.join(bd.DATA, 'countries', iso, 'areas.json'), encoding='utf-8'))
        adm1 = geoboundaries(iso, 'ADM1')
        adm2 = geoboundaries(iso, 'ADM2') or adm1
        a1polys = [bd.polygons(f['geometry']) for f in adm1]
        # district -> area: the area containing a point of the district
        a2 = []
        for f in adm2:
            polys = bd.polygons(f['geometry'])
            ring = max((r for p in polys for r in p[:1]), key=len)
            x, y = sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)
            parent = next((i for i, pp in enumerate(a1polys) if point_in_poly(x, y, pp)), None)
            if parent is None:                                                # centroid outside: nearest area centre
                parent = min(range(len(adm1)), key=lambda i: sum((q - w) ** 2 for q, w in zip(bd.bbox(a1polys[i])[:2], (x, y))))
            a2.append((f['properties'].get('shapeName', ''), parent, polys))
        # rasterise districts into this country's cells of every tile they touch
        touched = set()
        for k, (name, parent, polys) in enumerate(a2):
            x0, y0, x1, y1 = bd.bbox(polys)
            for tx in range(int((x0 - lon0) // bd.TILE_DEG), int((x1 - lon0) // bd.TILE_DEG) + 1):
                for ty in range(int((lat1 - y1) // bd.TILE_DEG), int((lat1 - y0) // bd.TILE_DEG) + 1):
                    if (tx, ty) not in tiles:
                        continue
                    key = f'{tx}_{ty}'
                    dist, road, water = tile_of(key)
                    cgrid = base[key]
                    for r, a, b in bd.raster_spans(polys, lon0 + tx * bd.TILE_DEG, lat1 - ty * bd.TILE_DEG, bd.S, N, N):
                        seg = cgrid[r, a:b + 1] == c
                        dist[r, a:b + 1][seg] = k + 1
                    touched.add(key)
        # fill this country's cells that no district covered (boundary datasets disagree) from neighbours
        for tx, ty in tiles:
            key = f'{tx}_{ty}'
            cg = load_tile(key) if key not in base else base[key]
            if not (cg == c).any():
                continue
            dist = tile_of(key)[0]
            q = deque(zip(*np.nonzero((cg == c) & (dist > 0))))
            while q:
                r, cc = q.popleft()
                for dr, dc in bd.DIRS4:
                    rr, c2 = r + dr, cc + dc
                    if 0 <= rr < N and 0 <= c2 < N and cg[rr, c2] == c and dist[rr, c2] == 0:
                        dist[rr, c2] = dist[r, cc]
                        q.append((rr, c2))
            touched.add(key)
        # area label points: the area's cell closest to the mean of its cells
        sums = {}
        for key in touched:
            tx, ty = map(int, key.split('_'))
            dist = layers[key][0]
            cg = base[key]
            rr, cc = np.nonzero((cg == c) & (dist > 0))
            for k in np.unique(dist[rr, cc]):
                sel = dist[rr, cc] == k
                p = a2[k - 1][1]
                glon = lon0 + (tx * N + cc[sel] + .5) * bd.S
                glat = lat1 - (ty * N + rr[sel] + .5) * bd.S
                s = sums.setdefault(p, [0.0, 0.0, 0, [], []])
                s[0] += glon.sum(); s[1] += glat.sum(); s[2] += len(glon)
                s[3].append(glon[::50]); s[4].append(glat[::50])
        areas = []
        sprites = json.load(open(os.path.join(bd.DATA, 'sprites.json')))['sprites']
        for m in bd_meta_sprites():
            sprites.setdefault(m[0], m[1])
        for i, f in enumerate(adm1):
            shape = f['properties'].get('shapeName', '')
            hand = areas_file['areas'].get(shape, {})
            s = sums.get(i)
            anchor = None
            if s:
                mx, my = s[0] / s[2], s[1] / s[2]
                xs, ys = np.concatenate(s[3]), np.concatenate(s[4])
                j = int(np.argmin((xs - mx) ** 2 + (ys - my) ** 2))
                anchor = [round(float(xs[j]), 4), round(float(ys[j]), 4)]
            sprite_id = (hand.get('item') or {}).get('sprite', 'bell')
            areas.append({'id': i + 1, 'shape': shape,
                          'name': hand.get('name', {'en': shape.title(), 'local': shape.title()}),
                          'item': {'name': (hand.get('item') or {}).get('name', 'Town Bell'), 'id': sprite_id,
                                   'sprite': sprites.get(sprite_id, sprites['bell'])},
                          'lore': hand.get('lore', ''), 'anchor': anchor, 'blocks': int(s[2]) if s else 0})
        bd.dump(os.path.join(bd.DATA, 'countries', f'{iso}.json'), {
            'code': iso, 'name': areas_file['name'], 'term': areas_file.get('term', 'province'),
            'tileCountry': c, 'areas': areas,
            'districts': [{'id': k + 1, 'name': n, 'area': p + 1} for k, (n, p, _) in enumerate(a2)],
        })
        print(f'{iso}: {len(areas)} areas, {len(a2)} districts, {len(touched)} tiles')

    # roads, railways, rivers and lakes from each extract
    for extract in sorted({GROUPS[i] for i in isos}):
        osm_layers(extract, lon0, lat1, tiles, tile_of, base, mine)

    for key, (dist, road, water) in layers.items():
        img = np.stack([(dist >> 8).astype(np.uint8), (dist & 255).astype(np.uint8), (road | (water << 3)).astype(np.uint8)], -1)
        Image.fromarray(img, 'RGB').save(os.path.join(bd.DATA, 'tiles', key + '.a.png'), optimize=True)
    # countries with detail so far
    path = os.path.join(bd.DATA, 'countries', 'index.json')
    done = json.load(open(path))['countries'] if os.path.exists(path) else []
    for iso in isos:
        info = json.load(open(os.path.join(bd.DATA, 'countries', f'{iso}.json')))
        done = [d for d in done if d['code'] != iso] + [{'code': iso, 'name': info['name'], 'term': info['term'],
                                                          'tileCountry': info['tileCountry']}]
    bd.dump(path, {'countries': done}, pretty=True)
    print(f'layers written for {len(layers)} tiles')


def bd_meta_sprites():
    """Thai province item sprites, so countries can reuse them by id (e.g. 'hornbill')."""
    out = []
    for slug in os.listdir(bd.PROV_DIR):
        m = json.load(open(os.path.join(bd.PROV_DIR, slug, 'province.json'), encoding='utf-8'))
        out.append((m['item']['id'], m['item']['sprite']))
    return out


def osm_layers(extract, lon0, lat1, tiles, tile_of, base, mine):
    """Rasterise one Geofabrik extract's roads, railways, rivers and lakes into the tile layers,
    only on cells of the countries being built (`mine`, tile country values)."""
    sys.path.insert(0, os.path.join(bd.CACHE, 'pylib'))
    import osmium
    import numpy as np
    path = os.path.join(bd.CACHE, f'{extract}-latest.osm.pbf')
    if not os.path.exists(path):
        print('downloading', extract, file=sys.stderr)
        urllib.request.urlretrieve(GEOFABRIK.format(extract), path)
    tset = set(tiles)

    def put(layer_i, gr, gc, code):
        tx, ty = gc // N, gr // N
        if (tx, ty) not in tset:
            return
        key = f'{tx}_{ty}'
        lay = tile_of(key)[layer_i]
        r, c = gr - ty * N, gc - tx * N
        if base[key][r, c] in mine and lay[r, c] < code:
            lay[r, c] = code

    def line(coords, layer_i, code, wide=False):
        cells = [(int((lat1 - y) / bd.S), int((x - lon0) / bd.S)) for x, y in coords]
        for (r0, c0), (r1, c1) in zip(cells, cells[1:]):
            dr, dc = abs(r1 - r0), -abs(c1 - c0)
            sr, sc = (1 if r0 < r1 else -1), (1 if c0 < c1 else -1)
            err = dr + dc
            while True:
                put(layer_i, r0, c0, code)
                if wide:
                    put(layer_i, r0 + 1, c0, code); put(layer_i, r0, c0 + 1, code)
                if r0 == r1 and c0 == c1:
                    break
                e2 = 2 * err
                if e2 >= dc and (e2 - dc <= dr - e2 or c0 == c1):
                    err += dc; r0 += sr
                else:
                    err += dr; c0 += sc

    rivers, counts = [], {'road': 0, 'rail': 0, 'river': 0}
    fp = osmium.FileProcessor(path, osmium.osm.NODE | osmium.osm.WAY).with_locations() \
        .with_filter(osmium.filter.KeyFilter('highway', 'railway', 'waterway'))
    for w in fp:
        if not w.is_way():
            continue
        t = w.tags
        hw, rw, ww = t.get('highway'), t.get('railway'), t.get('waterway')
        try:
            coords = [(nd.lon, nd.lat) for nd in w.nodes if nd.location.valid()]
        except osmium.InvalidLocationError:
            continue
        if len(coords) < 2:
            continue
        if hw in bd.ROAD_CODE:
            line(coords, 1, bd.ROAD_CODE[hw]); counts['road'] += 1
        elif rw == 'rail' and t.get('service') is None:
            line(coords, 1, bd.RAIL_CODE); counts['rail'] += 1
        elif ww == 'river':
            name = t.get('name:en') or t.get('name') or ''
            length = sum(math.dist(a, b) for a, b in zip(coords, coords[1:])) * 111
            rivers.append((name, length, coords)); counts['river'] += 1
    # main rivers: named rivers whose pieces add up to MAIN_RIVER_KM or more
    total = {}
    for name, length, _ in rivers:
        if name:
            total[name] = total.get(name, 0) + length
    main_names = {n for n, km in total.items() if km >= MAIN_RIVER_KM}
    for name, _, coords in rivers:
        main = name in main_names
        line(coords, 2, 2 if main else 1, main)
    # lakes and reservoirs over ~3 km²
    lakes = 0
    fp = osmium.FileProcessor(path).with_areas().with_filter(osmium.filter.TagFilter(('natural', 'water'), ('landuse', 'reservoir')))
    for o in fp:
        if not o.is_area() or o.tags.get('water') in ('river', 'canal', 'stream', 'wastewater', 'moat'):
            continue
        try:
            rings = [[(nd.lon, nd.lat) for nd in ring] for ring in o.outer_rings()]
            inner = [[(nd.lon, nd.lat) for nd in ir] for ring in o.outer_rings() for ir in o.inner_rings(ring)]
        except osmium.InvalidLocationError:
            continue
        if not rings or bd.area([[r] for r in rings]) < 0.00025:
            continue
        x0, y0, x1, y1 = bd.bbox([rings])
        W_ = math.ceil((x1 - x0) / bd.S) + 2; H_ = math.ceil((y1 - y0) / bd.S) + 2
        gc0, gr0 = int((x0 - lon0) / bd.S), int((lat1 - y1) / bd.S)
        for r, a, b in bd.raster_spans([rings + inner], lon0 + gc0 * bd.S, lat1 - gr0 * bd.S, bd.S, W_, H_):
            for cc in range(a, b + 1):
                put(2, gr0 + r, gc0 + cc, 3)
        lakes += 1
    print(f"{extract}: {counts['road']} road ways, {counts['rail']} rail ways, {counts['river']} river ways "
          f"({len(main_names)} main rivers), {lakes} lakes")


if __name__ == '__main__':
    build(sys.argv[1:] or ['MYS', 'SGP', 'BRN'])
