#!/usr/bin/env python3
"""Bring other countries up to Thailand's level of detail, one group at a time.

For each country group (see GROUPS) this reads:
  - first-level areas and districts: geoBoundaries ADM1 / ADM2 polygons (downloaded to
    tools/.cache/gb_<ISO>_<ADM>.geojson), or OpenStreetMap boundary relations for Hong Kong and
    Macau (OSM_ADMIN, cached as tools/.cache/osm_<ISO>_<ADM>.geojson)
  - data/countries/<ISO>/areas.json: hand-written iconic item per first-level area, and optional
    hand-picked district items (`districts`, keyed by the district's boundary name)
  - the group's OpenStreetMap extract (Geofabrik, or Overpass for Hong Kong + Macau), for roads,
    railways, rivers, lakes, landmarks (tagged with wikidata) and place names
and writes:
  - data/tiles/<tx>_<ty>.a.png   per-tile layers, RGB: district = R * 256 + G (1-based, within the
                                 block's country from the base tile), B = road | water << 3
                                 (road: 2–3 medium, 4 main, 5 railway; water: 1 small, 2 main
                                 river, 3 lake). Cells of other countries are kept as they were.
  - data/countries/<ISO>.json    areas (name, item + sprite, lore, label point) and districts
  - data/countries/<ISO>/area-<id>.json
                                 Thailand-style district raster for one area (finer than the
                                 blocks), with every district's item, landmark and places
  - data/countries/index.json    countries with detail so far, and the tiles each one covers (for 3D)

Usage: python3 tools/build_countries.py MYS SGP BRN HKG MAC
"""
import json, math, os, re, sys, urllib.parse, urllib.request
from collections import deque

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_data as bd                    # shared helpers: raster_spans, polygons, bbox, dump, S, …

GROUPS = {                                 # country -> OpenStreetMap extract that covers it
    'MYS': 'malaysia-singapore-brunei', 'SGP': 'malaysia-singapore-brunei', 'BRN': 'malaysia-singapore-brunei',
    'HKG': 'hongkong-macau', 'MAC': 'hongkong-macau',
}
GEOFABRIK = 'https://download.geofabrik.de/asia/{}-latest.osm.pbf'
OVERPASS = 'https://overpass-api.de/api/interpreter'
# Hong Kong and Macau have no Geofabrik extract: fetch just what the map uses from Overpass
OVERPASS_QUERIES = {
    'hongkong-macau': '''[out:xml][timeout:600];
(area(3600913110);area(3601867188);)->.a;
(
 rel["boundary"="administrative"]["admin_level"~"^(5|6)$"](area.a);
 way["highway"~"^(motorway|trunk|primary|secondary)(_link)?$"](area.a);
 way["railway"~"^(rail|subway|light_rail)$"](area.a);
 way["waterway"="river"](area.a);
 way["natural"="water"](area.a); rel["natural"="water"](area.a);
 way["landuse"="reservoir"](area.a); rel["landuse"="reservoir"](area.a);
 node["place"](area.a);
 nwr["wikidata"]["tourism"](area.a); nwr["wikidata"]["historic"](area.a); nwr["wikidata"]["natural"](area.a);
 nwr["wikidata"]["leisure"](area.a); nwr["wikidata"]["man_made"](area.a); nwr["wikidata"]["amenity"="place_of_worship"](area.a);
);
(._;>;);
out body;''',
}
# OpenStreetMap boundary relations for countries geoBoundaries does not split:
# ADM1 = {area name: [relation ids whose union is the area]}, ADM2 = district relation ids
OSM_ADMIN = {
    'HKG': {
        'ADM1': {'Hong Kong Island': [10264792], 'Kowloon': [10268797], 'New Territories': [10268964]},
        'ADM2': [2558879, 2558880, 2558881, 2558883, 2670978, 2800200, 2800201, 2800276, 2800277,
                 7351646, 8189562, 8191142, 8368100, 8477820, 8480494, 8480823, 9159733, 9159737],
    },
    'MAC': {
        'ADM1': {'Macau Peninsula': [9506156, 9506168, 12107627, 12107628, 12107629],
                 'Taipa': [5758865], 'Cotai': [5758867], 'Coloane': [5758866]},
        'ADM2': [9506156, 9506168, 12107627, 12107628, 12107629, 5758865, 5758867, 5758866],
    },
}
N = round(bd.TILE_DEG / bd.S)              # blocks per tile side (400)
MAIN_RIVER_KM = 80                         # a named river this long (all its pieces) counts as main
PLACE_RANK = {'city': 0, 'town': 1, 'suburb': 2, 'quarter': 3, 'village': 4, 'neighbourhood': 5}
MAX_PLACES = 60                            # place names listed per district
URBAN = {'SGP', 'HKG', 'MAC'}              # city states: flat districts are city, not farmland


def extract_path(extract):
    """Local copy of an extract: a Geofabrik .osm.pbf, or an Overpass .osm download."""
    if extract in OVERPASS_QUERIES:
        path = os.path.join(bd.CACHE, f'{extract}.osm')
        if not os.path.exists(path):
            print('downloading', extract, 'from Overpass', file=sys.stderr)
            req = urllib.request.Request(OVERPASS, data=urllib.parse.urlencode({'data': OVERPASS_QUERIES[extract]}).encode(),
                                         headers={'User-Agent': 'thailand-mc-map (github.com/akkharaphopmakanat/thailand-mc-map)'})
            with urllib.request.urlopen(req, timeout=900) as r, open(path, 'wb') as f:
                f.write(r.read())
        return path
    path = os.path.join(bd.CACHE, f'{extract}-latest.osm.pbf')
    if not os.path.exists(path):
        print('downloading', extract, file=sys.stderr)
        urllib.request.urlretrieve(GEOFABRIK.format(extract), path)
    return path


def osmium():
    sys.path.insert(0, os.path.join(bd.CACHE, 'pylib'))
    import osmium as o
    return o


def boundaries(iso, level):
    """[{properties: {shapeName, local?}, geometry}] for a country's ADM1 or ADM2."""
    path = os.path.join(bd.CACHE, f"{'osm' if iso in OSM_ADMIN else 'gb'}_{iso}_{level}.geojson")
    if not os.path.exists(path):
        if iso in OSM_ADMIN:
            bd.dump(path, {'type': 'FeatureCollection', 'features': osm_boundaries(iso, level)})
        else:
            meta = json.load(urllib.request.urlopen(f'https://www.geoboundaries.org/api/current/gbOpen/{iso}/{level}/'))
            urllib.request.urlretrieve(meta['simplifiedGeometryGeoJSON'], path)
    with open(path, encoding='utf-8') as f:
        return json.load(f)['features']


def local_name(tags):
    """The Chinese part of names like '中西區 Central and Western District'."""
    for k in ('name:zh-Hant', 'name:zh_Hant', 'name:zh'):
        if tags.get(k):
            return tags[k]
    return re.sub(r'[\x00-ɏ]+', ' ', tags.get('name', '')).strip()


def osm_boundaries(iso, level):
    o = osmium()
    spec = OSM_ADMIN[iso]
    want = {i for ids in spec['ADM1'].values() for i in ids} | set(spec['ADM2'])
    shapes = {}
    fp = o.FileProcessor(extract_path(GROUPS[iso])).with_areas().with_filter(o.filter.TagFilter(('boundary', 'administrative')))
    for a in fp:
        if not a.is_area() or a.from_way() or a.orig_id() not in want:
            continue
        polys = []
        for outer in a.outer_rings():
            poly = [[[nd.lon, nd.lat] for nd in outer]]
            poly += [[[nd.lon, nd.lat] for nd in inner] for inner in a.inner_rings(outer)]
            polys.append(poly)
        t = a.tags
        shapes[a.orig_id()] = {'name': t.get('name:en') or t.get('name:pt') or t.get('name'),
                               'local': local_name(t), 'polys': polys}
    missing = want - set(shapes)
    if missing:
        raise SystemExit(f'{iso}: boundary relations missing from the extract: {sorted(missing)}')
    if level == 'ADM1':
        return [{'properties': {'shapeName': name, 'local': ''},
                 'geometry': {'type': 'MultiPolygon', 'coordinates': [p for i in ids for p in shapes[i]['polys']]}}
                for name, ids in spec['ADM1'].items()]
    return [{'properties': {'shapeName': shapes[i]['name'], 'local': shapes[i]['local'],
                            'parent': next(n for n, ids in spec['ADM1'].items() if i in ids) if iso == 'MAC' else None},
             'geometry': {'type': 'MultiPolygon', 'coordinates': shapes[i]['polys']}} for i in spec['ADM2']]


def point_in_poly(x, y, polys):
    inside = False
    for poly in polys:
        for ring in poly:
            for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
                if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
                    inside = not inside
    return inside


def load_tile(key):
    """Base tile as numpy arrays: country value per block, elevation (m) per block."""
    import numpy as np
    from PIL import Image
    a = np.asarray(Image.open(os.path.join(bd.DATA, 'tiles', key + '.png')).convert('RGB')).astype(np.int32)
    return a[..., 2].copy(), a[..., 0] * 256 + a[..., 1] - 32768


def nice(name):
    """'ANG MO KIO' -> 'Ang Mo Kio' (geoBoundaries has some names in capitals)."""
    return name.title() if name.isupper() else name


def build(isos):
    import numpy as np
    from PIL import Image
    index = json.load(open(os.path.join(bd.DATA, 'tiles', 'index.json')))
    cidx = {c['code']: i + 1 for i, c in enumerate(index['countries'])}      # tile country value per ISO
    lon0, lat1 = index['lon0'], index['lat1']
    tiles = [tuple(t) for t in index['tiles']]
    tset = set(tiles)
    base, elev = {}, {}                                                       # key -> country grid, elevation grid
    layers = {}                                                               # key -> (district u16, road u8, water u8)

    def tile_of(key):
        if key not in layers:
            base[key], elev[key] = load_tile(key)
            path = os.path.join(bd.DATA, 'tiles', key + '.a.png')
            if os.path.exists(path):
                a = np.asarray(Image.open(path).convert('RGB')).astype(np.int32)
                layers[key] = [(a[..., 0] << 8) | a[..., 1], a[..., 2] & 7, a[..., 2] >> 3]
            else:
                layers[key] = [np.zeros((N, N), np.int32), np.zeros((N, N), np.int32), np.zeros((N, N), np.int32)]
        return layers[key]

    def owner(lon, lat):
        """(tile country value, district id) of the block at a point, or (0, 0)."""
        gr, gc = int((lat1 - lat) / bd.S), int((lon - lon0) / bd.S)
        tx, ty = gc // N, gr // N
        if (tx, ty) not in tset:
            return 0, 0
        key = f'{tx}_{ty}'
        dist = tile_of(key)[0]
        return int(base[key][gr - ty * N, gc - tx * N]), int(dist[gr - ty * N, gc - tx * N])

    # clear the districts of the countries being rebuilt, so shapes that moved leave nothing behind
    mine = {cidx[i] for i in isos}
    for tx, ty in tiles:
        key = f'{tx}_{ty}'
        if os.path.exists(os.path.join(bd.DATA, 'tiles', key + '.a.png')):
            dist = tile_of(key)[0]
            dist[np.isin(base[key], list(mine))] = 0

    built = {}
    for iso in isos:
        c = cidx[iso]
        areas_file = json.load(open(os.path.join(bd.DATA, 'countries', iso, 'areas.json'), encoding='utf-8'))
        adm1 = boundaries(iso, 'ADM1')
        adm2 = boundaries(iso, 'ADM2') or adm1
        a1names = [f['properties'].get('shapeName', '') for f in adm1]
        a1polys = [bd.polygons(f['geometry']) for f in adm1]
        # district -> area: given (Macau), else the area containing a point of the district
        a2 = []
        for f in adm2:
            polys = bd.polygons(f['geometry'])
            pr = f['properties']
            if pr.get('parent'):
                parent = a1names.index(pr['parent'])
            else:
                ring = max((r for p in polys for r in p[:1]), key=len)
                x, y = sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)
                parent = next((i for i, pp in enumerate(a1polys) if point_in_poly(x, y, pp)), None)
                if parent is None:                                            # centroid outside: nearest area centre
                    parent = min(range(len(adm1)), key=lambda i: sum((q - w) ** 2 for q, w in zip(bd.bbox(a1polys[i])[:2], (x, y))))
            a2.append((pr.get('shapeName', ''), parent, polys, pr.get('local', '')))
        # an area without districts of its own (Putrajaya) is one district, drawn over its neighbours
        for i, f in enumerate(adm1):
            if not any(p == i for _, p, _, _ in a2):
                a2.append((a1names[i], i, a1polys[i], f['properties'].get('local', '')))
        # rasterise districts into this country's cells of every tile they touch
        touched = set()
        for k, (name, parent, polys, _) in enumerate(a2):
            x0, y0, x1, y1 = bd.bbox(polys)
            for tx in range(int((x0 - lon0) // bd.TILE_DEG), int((x1 - lon0) // bd.TILE_DEG) + 1):
                for ty in range(int((lat1 - y1) // bd.TILE_DEG), int((lat1 - y0) // bd.TILE_DEG) + 1):
                    if (tx, ty) not in tset:
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
            cg = load_tile(key)[0] if key not in base else base[key]
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
        sprites = sprite_library()
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
                          'name': hand.get('name', {'en': nice(shape), 'local': nice(shape)}),
                          'item': {'name': (hand.get('item') or {}).get('name', 'Town Bell'), 'id': sprite_id,
                                   'sprite': sprites.get(sprite_id, sprites['bell'])},
                          'lore': hand.get('lore', ''), 'biome': hand.get('biome', 'sparse_jungle'),
                          'anchor': anchor, 'blocks': int(s[2]) if s else 0})
        built[iso] = (c, areas_file, areas, a2, sorted(touched))
        print(f'{iso}: {len(areas)} areas, {len(a2)} districts, {len(touched)} tiles')

    # roads, railways, rivers, lakes, landmarks and place names from each extract
    pois, places = {}, {}                                  # (country value, district id) -> [...]
    for extract in sorted({GROUPS[i] for i in isos}):
        osm_layers(extract, lon0, lat1, tset, tile_of, base, mine, owner, pois, places)

    for iso in isos:
        c, areas_file, areas, a2, _ = built[iso]
        curated = areas_file.get('districts', {})
        unknown = set(curated) - {n for n, *_ in a2}
        if unknown:
            print(f'  {iso}: district items with unknown names: {sorted(unknown)}', file=sys.stderr)
        names = [curated.get(n, {}).get('name') or {'en': nice(n), 'local': loc or ''} for n, _, _, loc in a2]
        for a in areas:
            area_detail(iso, c, a, a2, names, curated, pois, places, lon0, lat1, tset, tile_of, base, elev)
        bd.dump(os.path.join(bd.DATA, 'countries', f'{iso}.json'), {
            'code': iso, 'name': areas_file['name'], 'term': areas_file.get('term', 'province'),
            'districtTerm': areas_file.get('districtTerm', 'district'), 'placeTerm': areas_file.get('placeTerm', 'place'),
            'tileCountry': c, 'areas': areas,
            'districts': [{'id': k + 1, 'name': names[k]['en'], 'area': p + 1} for k, (_, p, _, _) in enumerate(a2)],
        })

    for key, (dist, road, water) in layers.items():
        img = np.stack([(dist >> 8).astype(np.uint8), (dist & 255).astype(np.uint8), (road | (water << 3)).astype(np.uint8)], -1)
        Image.fromarray(img, 'RGB').save(os.path.join(bd.DATA, 'tiles', key + '.a.png'), optimize=True)
    # countries with detail so far
    path = os.path.join(bd.DATA, 'countries', 'index.json')
    done = json.load(open(path))['countries'] if os.path.exists(path) else []
    for iso in isos:
        info = json.load(open(os.path.join(bd.DATA, 'countries', f'{iso}.json')))
        done = [d for d in done if d['code'] != iso] + [{'code': iso, 'name': info['name'], 'term': info['term'],
                                                          'tileCountry': info['tileCountry'], 'tiles': built[iso][4]}]
    bd.dump(path, {'countries': done}, pretty=True)
    print(f'layers written for {len(layers)} tiles')


def sprite_library():
    """Shared sprites plus every Thai province's item sprite, so countries can reuse them by id."""
    lib = json.load(open(os.path.join(bd.DATA, 'sprites.json')))['sprites']
    for slug in os.listdir(bd.PROV_DIR):
        m = json.load(open(os.path.join(bd.PROV_DIR, slug, 'province.json'), encoding='utf-8'))
        lib.setdefault(m['item']['id'], m['item']['sprite'])
    return lib


# ---------------------------------------------------------------- district detail per area
def area_detail(iso, c, area, a2, names, curated, pois, places, lon0, lat1, tset, tile_of, base, elev):
    """Write data/countries/<iso>/area-<id>.json: the area's districts on a raster finer than the
    blocks (same format as a Thai province's districts.json), with item, landmark and places."""
    import numpy as np
    members = [k for k, (_, p, _, _) in enumerate(a2) if p + 1 == area['id']]
    if not members:
        return
    polys = [p for k in members for p in a2[k][2]]
    x0, y0, x1, y1 = bd.bbox(polys)
    res = round(min(bd.S, max(0.00125, math.sqrt((x1 - x0) * (y1 - y0) / 60000))), 5)
    g_lon0, g_lat1 = x0 - res, y1 + res
    w = math.ceil((x1 - g_lon0) / res) + 2
    h = math.ceil((g_lat1 - y0) / res) + 2

    # the block under every cell: country, district (tile layer), elevation, coast
    gc = ((g_lon0 + (np.arange(w) + .5) * res - lon0) / bd.S).astype(int)
    gr = ((lat1 - (g_lat1 - (np.arange(h) + .5) * res)) / bd.S).astype(int)
    bc = np.zeros((h, w), np.int32); bdist = np.zeros((h, w), np.int32)
    bel = np.zeros((h, w), np.int32); bcoast = np.zeros((h, w), bool)
    for ty in np.unique(gr // N):
        rs = np.nonzero(gr // N == ty)[0]
        for tx in np.unique(gc // N):
            if (tx, ty) not in tset:
                continue
            cs = np.nonzero(gc // N == tx)[0]
            key = f'{tx}_{ty}'
            dist = tile_of(key)[0]
            cg, eg = base[key], elev[key]
            land = cg > 0
            coast = land & ~(np.pad(land, 1, constant_values=True)[:-2, 1:-1] & np.pad(land, 1, constant_values=True)[2:, 1:-1]
                             & np.pad(land, 1, constant_values=True)[1:-1, :-2] & np.pad(land, 1, constant_values=True)[1:-1, 2:])
            ix = np.ix_(rs, cs)
            li = np.ix_(gr[rs] - ty * N, gc[cs] - tx * N)
            bc[ix] = cg[li]; bdist[ix] = dist[li]; bel[ix] = eg[li]; bcoast[ix] = coast[li]
    local = np.full(len(a2) + 1, -1, np.int32)
    for j, k in enumerate(members):
        local[k + 1] = j
    # cells of this area's blocks, labelled from the blocks, then refined by the district shapes
    bdist = np.where((bc == c) & (bdist <= len(a2)), bdist, 0)   # other countries' ids mean nothing here
    inside = (bc == c) & (local[bdist] >= 0)
    grid = np.where(inside, local[bdist], -1)
    for j, k in enumerate(members):
        for r, a, b in bd.raster_spans(a2[k][2], g_lon0, g_lat1, res, w, h):
            seg = inside[r, a:b + 1]
            grid[r, a:b + 1][seg] = j
    anc, cells = bd.anchors(grid.tolist(), w, h, len(members))

    lib = sprite_library()
    districts = []
    for j, k in enumerate(members):
        sel = grid == j
        e = float(np.maximum(bel[sel], 0).mean()) if sel.any() else 0.0
        coastal = bool(bcoast[sel].any())
        found = sorted(pois.get((c, k + 1), []), key=lambda p: -p['score'])
        lm = found[0] if found else None
        hand = curated.get(a2[k][0])
        if hand:
            item = {'name': hand['item'], 'sprite': hand['sprite'], 'note': hand['note'], 'kind': 'landmark'}
            if lm and lm['name'].lower() in (hand['item'] + hand['note']).lower():
                lm = found[1] if len(found) > 1 else None
        elif lm:
            item = {'name': lm['name'], 'sprite': lm['sprite'], 'kind': 'landmark',
                    'note': f"{lm['label']}{' · ' + lm['local'] if lm['local'] else ''}. The best-known landmark here on OpenStreetMap."}
            lm = found[1] if len(found) > 1 else None
        else:
            item = terrain_item(iso, e, coastal)
        pl = sorted(places.get((c, k + 1), []), key=lambda p: (PLACE_RANK[p['kind']], p['name']['en']))
        districts.append({
            'id': k + 1, 'name': names[k], 'anchor': anc[j], 'cells': cells[j], 'elevation': int(round(e)),
            'item': item,
            'landmark': {'name': lm['name'], 'sprite': lm['sprite'], 'note': f"{lm['label']}{' · ' + lm['local'] if lm['local'] else ''}."} if lm else None,
            'places': [{'name': p['name'], 'kind': p['kind']} for p in pl[:MAX_PLACES]],
            'placeCount': len(pl),
        })
    used = {d['item']['sprite'] for d in districts} | {d['landmark']['sprite'] for d in districts if d['landmark']}
    chars = [chr(v) for v in range(0x30, 0x7f) if chr(v) not in '\\`~.'] + [chr(v) for v in range(0xc0, 0x250)]
    rows = [bd.rle(''.join(chars[v] if v >= 0 else '.' for v in row)) for row in grid.tolist()]
    os.makedirs(os.path.join(bd.DATA, 'countries', iso), exist_ok=True)
    bd.dump(os.path.join(bd.DATA, 'countries', iso, f"area-{area['id']}.json"), {
        'province': f"{iso}-{area['id']}", 'country': iso, 'area': area['id'],
        'res': res, 'lon0': g_lon0, 'lat1': g_lat1, 'w': w, 'h': h, 'chars': ''.join(chars[:len(members)]),
        'districts': districts, 'sprites': {s: lib[s] for s in sorted(used)}, 'rows': rows,
    })


def terrain_item(iso, elev, coastal):
    e = f'average elevation about {int(round(elev, -1))} m'
    if elev >= 700:
        return {'name': 'Stone', 'sprite': 'mountain', 'note': f'Mountain district, {e}.', 'kind': 'terrain'}
    if elev >= 250:
        return {'name': 'Jungle Sapling', 'sprite': 'tree', 'note': f'Forested hills, {e}.', 'kind': 'terrain'}
    if iso in URBAN:
        return {'name': 'Skyscraper', 'sprite': 'tower', 'note': f'Urban district, {e}.', 'kind': 'terrain'}
    if coastal:
        return {'name': 'Raw Fish', 'sprite': 'fish', 'note': f'Coastal district, {e}.', 'kind': 'terrain'}
    return {'name': 'Rubber Tree', 'sprite': 'rubberTree', 'note': f'Rubber and oil palm plantations; {e}.', 'kind': 'terrain'}


# ---------------------------------------------------------------- landmarks
WORSHIP = {'muslim': ('mosque', 'Mosque'), 'christian': ('church', 'Church'), 'buddhist': ('stupa', 'Buddhist temple'),
           'hindu': ('shrine', 'Hindu temple'), 'taoist': ('redLantern', 'Chinese temple'),
           'chinese_folk': ('redLantern', 'Chinese temple'), 'confucian': ('redLantern', 'Chinese temple'),
           'sikh': ('goldDome', 'Gurdwara')}


def poi_kind(t):
    """(sprite, label, weight) for a landmark-worthy OSM feature, or None."""
    g = t.get
    if g('amenity') == 'place_of_worship':
        return (*WORSHIP.get(g('religion'), ('shrine', 'Place of worship')), 2)
    if g('waterway') == 'waterfall' or g('natural') == 'waterfall':
        return 'waterfall', 'Waterfall', 3
    if g('man_made') == 'lighthouse':
        return 'lighthouse', 'Lighthouse', 3
    if g('historic') in ('fort', 'castle'):
        return 'castle', 'Fort', 3
    if g('historic') in ('ruins', 'archaeological_site'):
        return 'ruins', 'Ruins', 3
    if g('historic') in ('monument', 'memorial'):
        return 'monument', 'Monument', 2
    if g('tourism') in ('museum', 'gallery'):
        return 'painting', 'Museum', 3
    if g('tourism') == 'zoo':
        return 'monkey', 'Zoo', 3
    if g('tourism') == 'aquarium':
        return 'tropicalFish', 'Aquarium', 3
    if g('tourism') == 'theme_park':
        return 'minecart', 'Theme park', 3
    if g('natural') in ('peak', 'volcano'):
        return 'mountain', 'Peak', 0
    if g('natural') == 'cave_entrance':
        return 'cave', 'Cave', 3
    if g('natural') == 'beach':
        return 'palm', 'Beach', 2
    if g('natural') in ('island', 'islet'):
        return 'palm', 'Island', 1
    if g('man_made') == 'bridge':
        return 'bridge', 'Bridge', 2
    if g('man_made') == 'tower':
        return 'tower', 'Tower', 1
    if g('leisure') in ('park', 'nature_reserve', 'garden'):
        return 'tree', 'Park', 1
    if g('leisure') == 'stadium':
        return 'ball', 'Stadium', 1
    if g('tourism') in ('attraction', 'viewpoint'):
        return ('mountainCloud', 'Viewpoint', 2) if g('tourism') == 'viewpoint' else ('painting', 'Attraction', 2)
    if g('historic'):
        return 'monument', 'Historic site', 2
    return None


def poi_score(t, weight):
    """How well known a feature is: names in other languages, a Wikipedia article, its kind."""
    langs = min(sum(1 for tag in t if tag.k.startswith('name:')), 12)   # bots add dozens to some hills
    ele = t.get('ele', '')
    peak = float(ele) / 500 - 3 if t.get('natural') == 'peak' and re.fullmatch(r'\d+(\.\d+)?', ele) else 0
    return langs + (6 if t.get('wikipedia') else 0) + weight + peak


def latin_name(t):
    en = t.get('name:en') or ''
    name = t.get('name', '')
    if not en:
        latin = re.sub(r'[^\x00-ɏ]+', ' ', name).strip()
        en = latin if len(latin) >= 3 else name
    loc = local_name(t) if t.get('name') else ''
    return en.strip(), (loc if loc and loc != en else '')


def osm_layers(extract, lon0, lat1, tset, tile_of, base, mine, owner, pois, places):
    """Rasterise one extract's roads, railways, rivers and lakes into the tile layers, only on cells
    of the countries being built (`mine`, tile country values); collect landmarks and place names
    per (country value, district id)."""
    o = osmium()
    import numpy as np
    path = extract_path(extract)

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

    def landmark(t, lon, lat):
        kind = poi_kind(t) if t.get('wikidata') and t.get('name') else None
        if not kind:
            return
        cv, d = owner(lon, lat)
        if cv in mine and d:
            en, loc = latin_name(t)
            pois.setdefault((cv, d), []).append({'name': en, 'local': loc, 'sprite': kind[0], 'label': kind[1],
                                                 'score': poi_score(t, kind[2])})

    rivers, counts = [], {'road': 0, 'rail': 0, 'river': 0, 'landmark': 0, 'place': 0}
    keys = ('highway', 'railway', 'waterway', 'place', 'tourism', 'historic', 'natural', 'leisure', 'man_made', 'amenity')
    fp = o.FileProcessor(path, o.osm.NODE | o.osm.WAY).with_locations().with_filter(o.filter.KeyFilter(*keys))
    for w in fp:
        t = w.tags
        if w.is_node():
            if not w.location.valid():
                continue
            if t.get('place') in PLACE_RANK and t.get('name'):
                cv, d = owner(w.location.lon, w.location.lat)
                if cv in mine and d:
                    en, loc = latin_name(t)
                    places.setdefault((cv, d), []).append({'name': {'en': en, 'local': loc}, 'kind': t['place']})
                    counts['place'] += 1
            else:
                landmark(t, w.location.lon, w.location.lat)
            continue
        if not w.is_way():
            continue
        hw, rw, ww = t.get('highway'), t.get('railway'), t.get('waterway')
        try:
            coords = [(nd.lon, nd.lat) for nd in w.nodes if nd.location.valid()]
        except o.InvalidLocationError:
            continue
        if len(coords) < 2:
            continue
        if hw in bd.ROAD_CODE:
            line(coords, 1, bd.ROAD_CODE[hw]); counts['road'] += 1
        elif (rw == 'rail' and t.get('service') is None) or (rw in ('subway', 'light_rail') and t.get('tunnel') is None):
            line(coords, 1, bd.RAIL_CODE); counts['rail'] += 1
        elif ww == 'river':
            name = t.get('name:en') or t.get('name') or ''
            length = sum(math.dist(a, b) for a, b in zip(coords, coords[1:])) * 111
            rivers.append((name, length, coords)); counts['river'] += 1
        else:
            landmark(t, sum(x for x, _ in coords) / len(coords), sum(y for _, y in coords) / len(coords))
    counts['landmark'] = sum(len(v) for v in pois.values())
    # main rivers: named rivers whose pieces add up to MAIN_RIVER_KM or more
    total = {}
    for name, length, _ in rivers:
        if name:
            total[name] = total.get(name, 0) + length
    main_names = {n for n, km in total.items() if km >= MAIN_RIVER_KM}
    for name, _, coords in rivers:
        main = name in main_names
        line(coords, 2, 2 if main else 1, main)
    # lakes and reservoirs over ~3 km² (~0.3 km² in the small city territories)
    small = extract in OVERPASS_QUERIES
    lakes = 0
    fp = o.FileProcessor(path).with_areas().with_filter(o.filter.TagFilter(('natural', 'water'), ('landuse', 'reservoir')))
    for a in fp:
        if not a.is_area() or a.tags.get('water') in ('river', 'canal', 'stream', 'wastewater', 'moat'):
            continue
        try:
            rings = [[(nd.lon, nd.lat) for nd in ring] for ring in a.outer_rings()]
            inner = [[(nd.lon, nd.lat) for nd in ir] for ring in a.outer_rings() for ir in a.inner_rings(ring)]
        except o.InvalidLocationError:
            continue
        if not rings or bd.area([[r] for r in rings]) < (0.000025 if small else 0.00025):
            continue
        x0, y0, x1, y1 = bd.bbox([rings])
        W_ = math.ceil((x1 - x0) / bd.S) + 2; H_ = math.ceil((y1 - y0) / bd.S) + 2
        gc0, gr0 = int((x0 - lon0) / bd.S), int((lat1 - y1) / bd.S)
        spans = list(bd.raster_spans([rings + inner], lon0 + gc0 * bd.S, lat1 - gr0 * bd.S, bd.S, W_, H_))
        if not spans:                                     # smaller than a block: mark the block it sits in
            spans = [(round((lat1 - (y0 + y1) / 2) / bd.S) - gr0, round(((x0 + x1) / 2 - lon0) / bd.S) - gc0,
                      round(((x0 + x1) / 2 - lon0) / bd.S) - gc0)]
        for r, a_, b in spans:
            for cc in range(a_, b + 1):
                put(2, gr0 + r, gc0 + cc, 3)
        lakes += 1
    print(f"{extract}: {counts['road']} road ways, {counts['rail']} rail ways, {counts['river']} river ways "
          f"({len(main_names)} main rivers), {lakes} lakes, {counts['landmark']} landmarks, {counts['place']} places")


if __name__ == '__main__':
    build(sys.argv[1:] or ['MYS', 'SGP', 'BRN', 'HKG', 'MAC'])
