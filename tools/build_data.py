#!/usr/bin/env python3
"""Regenerate the generated data files under data/.

Hand-written content lives in data/provinces/<slug>/province.json (including
optional `district_items` landmarks keyed by district English name) and
data/sprites.json; this script never touches them. It (re)writes:

  data/map.json                               province block grid for the whole country (0.02° blocks)
  data/provinces/<slug>/districts.json        amphoe / khet raster + names
  data/provinces/<slug>/subdistricts.json     tambon / khwaeng names + postcodes
  data/elevation.json                         mean height (m) per map block, land and sea
  data/roads.json                             highways and roads as world-pixel polylines

Sources (downloaded into tools/.cache on first run):
  th.json       province polygons      github.com/apisit/thailand.json
  adm2.geojson  district polygons      geoBoundaries THA ADM2 (CC BY 3.0 IGO)
  pds.json      Thai admin names       github.com/kongvut/thai-province-data (MIT)
  terrarium/    elevation tiles, z8    AWS Terrain Tiles (Mapzen terrarium encoding)
  ne_10m_roads.geojson  roads          Natural Earth 1:10m roads (public domain)

Usage: python3 tools/build_data.py
"""
import base64, json, math, os, re, sys, urllib.request
from collections import deque
from difflib import SequenceMatcher

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'tools', '.cache')
DATA = os.path.join(ROOT, 'data')
PROV_DIR = os.path.join(DATA, 'provinces')

SOURCES = {
    'th.json': 'https://raw.githubusercontent.com/apisit/thailand.json/master/thailand.json',
    'adm2.geojson': 'https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/THA/ADM2/geoBoundaries-THA-ADM2_simplified.geojson',
    'pds.json': 'https://raw.githubusercontent.com/kongvut/thai-province-data/master/api/latest/province_with_district_and_sub_district.json',
    'ne_10m_roads.geojson': 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_roads.geojson',
}

# Country grid: 0.02° blocks (~2.2 km)
S = 0.02
LON0, LON1, LAT0, LAT1 = 97.2, 105.8, 5.4, 20.6
# Symbols used to encode province indices in map.json rows ('.' sea, ',' foreign land, '~' RLE marker)
CHARS = [chr(c) for c in range(0x21, 0x7f) if chr(c) not in '"\\`\'$~.,-'][:77]
DIRS4 = ((1, 0), (-1, 0), (0, 1), (0, -1))
# English names that are wrong in pds.json (the Thai names are right)
NAME_FIXES = {6008: 'Tha Tako', 6011: 'Lat Yao'}


def source(name):
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        os.makedirs(CACHE, exist_ok=True)
        print('downloading', name, '...', file=sys.stderr)
        urllib.request.urlretrieve(SOURCES[name], path)
    with open(path, encoding='utf-8') as f:
        return json.load(f)


# ---------------------------------------------------------------- elevation
TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
TILE_Z = 8  # ~0.6 km pixels, averaged down to 0.02° blocks


def tile_xy(lat, lon, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def build_elevation():
    """Mean elevation (metres, negative = sea depth) per 0.02° block, written as base64 int16."""
    import numpy as np
    from PIL import Image
    W = round((LON1 - LON0) / S); H = round((LAT1 - LAT0) / S)
    x0, y0 = tile_xy(LAT1, LON0, TILE_Z)
    x1, y1 = tile_xy(LAT0, LON1, TILE_Z)
    tx0, ty0, tx1, ty1 = int(x0), int(y0), int(x1), int(y1)
    mosaic = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), dtype=np.float32)
    tdir = os.path.join(CACHE, 'terrarium')
    os.makedirs(tdir, exist_ok=True)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            path = os.path.join(tdir, f'{TILE_Z}_{tx}_{ty}.png')
            if not os.path.exists(path):
                print('downloading tile', tx, ty, file=sys.stderr)
                urllib.request.urlretrieve(TILE_URL.format(z=TILE_Z, x=tx, y=ty), path)
            px = np.asarray(Image.open(path).convert('RGB'), dtype=np.float32)
            elev = px[..., 0] * 256 + px[..., 1] + px[..., 2] / 256 - 32768
            mosaic[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = elev
    # 4x4 samples per block, averaged
    k = 4
    lats = LAT1 - (np.arange(H * k) + .5) * S / k
    lons = LON0 + (np.arange(W * k) + .5) * S / k
    n = 2 ** TILE_Z
    py = ((1 - np.arcsinh(np.tan(np.radians(lats))) / np.pi) / 2 * n - ty0) * 256
    px_ = ((lons + 180) / 360 * n - tx0) * 256
    py = np.clip(py.astype(int), 0, mosaic.shape[0] - 1)
    px_ = np.clip(px_.astype(int), 0, mosaic.shape[1] - 1)
    fine = mosaic[np.ix_(py, px_)]
    blocks = fine.reshape(H, k, W, k).mean(axis=(1, 3))
    heights = np.round(blocks).astype('<i2')
    dump(os.path.join(DATA, 'elevation.json'), {
        'W': W, 'H': H, 'unit': 'm', 'encoding': 'int16le-base64', 'source': 'terrarium',
        'min': int(heights.min()), 'max': int(heights.max()),
        'data': base64.b64encode(heights.tobytes()).decode('ascii'),
    })
    print(f'elevation.json: {heights.min()} .. {heights.max()} m')
    return heights.astype(int).tolist()


# ---------------------------------------------------------------- roads
PX_PER_DEG = 200  # world pixels per degree: B / S in js/config.js and map.json (4 px per 0.02° block)


def simplify(pts, tol):
    """Douglas–Peucker line simplification."""
    if len(pts) < 3:
        return pts
    (x0, y0), (x1, y1) = pts[0], pts[-1]
    dx, dy = x1 - x0, y1 - y0
    norm = math.hypot(dx, dy) or 1e-12
    best, bi = 0, 0
    for i in range(1, len(pts) - 1):
        d = abs(dy * (pts[i][0] - x0) - dx * (pts[i][1] - y0)) / norm
        if d > best:
            best, bi = d, i
    if best <= tol:
        return [pts[0], pts[-1]]
    return simplify(pts[:bi + 1], tol)[:-1] + simplify(pts[bi:], tol)


def build_roads():
    """Natural Earth roads inside the map, in world pixels. scalerank ≤ 5 or expressway → highway."""
    px = PX_PER_DEG
    out = {'highway': [], 'road': []}
    for f in source('ne_10m_roads.geojson')['features']:
        g = f['geometry']
        if not g:
            continue
        lines = g['coordinates'] if g['type'] == 'MultiLineString' else [g['coordinates']]
        p = f['properties']
        cls = 'highway' if (p.get('scalerank') or 99) <= 5 or p.get('expressway') == 1 else 'road'
        for line in lines:
            if not any(LON0 <= x <= LON1 and LAT0 <= y <= LAT1 for x, y in line):
                continue
            pts = simplify([(x, y) for x, y in line], 0.004)
            flat = []
            for x, y in pts:
                flat += [round((x - LON0) * px), round((LAT1 - y) * px)]
            out[cls].append(flat)
    dump(os.path.join(DATA, 'roads.json'), {'units': f'world px ({PX_PER_DEG} per degree)', **out})
    print(f"roads.json: {len(out['highway'])} highway lines, {len(out['road'])} road lines")


def polygons(geom):
    return geom['coordinates'] if geom['type'] == 'MultiPolygon' else [geom['coordinates']]


def bbox(polys):
    xs = [p[0] for poly in polys for ring in poly for p in ring]
    ys = [p[1] for poly in polys for ring in poly for p in ring]
    return min(xs), min(ys), max(xs), max(ys)


def area(polys):
    a = 0.0
    for poly in polys:
        for k, ring in enumerate(poly):
            s = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1])) / 2
            a += abs(s) if k == 0 else -abs(s)
    return a


def raster_spans(polys, lon0, lat1, res, w, h):
    """Even-odd scanline fill. Yields (row, col_start, col_end_inclusive) for cell centres inside."""
    rows = {}
    for poly in polys:
        for ring in poly:
            for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
                if y0 == y1:
                    continue
                ya, yb = min(y0, y1), max(y0, y1)
                ra = math.ceil((lat1 - yb) / res - 0.5)
                rb = math.floor((lat1 - ya) / res - 0.5)
                for r in range(max(ra, 0), min(rb, h - 1) + 1):
                    yc = lat1 - (r + .5) * res
                    if ya <= yc < yb:
                        rows.setdefault(r, []).append(x0 + (yc - y0) * (x1 - x0) / (y1 - y0))
    for r, xs in rows.items():
        xs.sort()
        for a, b in zip(xs[0::2], xs[1::2]):
            ca = max(math.ceil((a - lon0) / res - 0.5), 0)
            cb = min(math.floor((b - lon0) / res - 0.5), w - 1)
            if ca <= cb:
                yield r, ca, cb


def rle(s):
    out, i = [], 0
    while i < len(s):
        j = i
        while j < len(s) and s[j] == s[i]:
            j += 1
        n = j - i
        out.append(s[i] * n if n < 4 else f'{s[i]}~{n}~')
        i = j
    return ''.join(out)


def distance_inside(grid, w, h):
    """4-neighbour distance (in cells) from each labelled cell to its region's edge."""
    dist = [[0] * w for _ in range(h)]
    q = deque()
    for r in range(h):
        for c in range(w):
            v = grid[r][c]
            if v < 0:
                continue
            for dr, dc in DIRS4:
                rr, cc = r + dr, c + dc
                if not (0 <= rr < h and 0 <= cc < w) or grid[rr][cc] != v:
                    dist[r][c] = 1
                    q.append((r, c))
                    break
    while q:
        r, c = q.popleft()
        for dr, dc in DIRS4:
            rr, cc = r + dr, c + dc
            if 0 <= rr < h and 0 <= cc < w and grid[rr][cc] == grid[r][c] and dist[rr][cc] == 0:
                dist[rr][cc] = dist[r][c] + 1
                q.append((rr, cc))
    return dist


def anchors(grid, w, h, n):
    """Label point per region: deep inside, near the centroid."""
    dist = distance_inside(grid, w, h)
    sums = [[0, 0, 0] for _ in range(n)]
    for r in range(h):
        for c in range(w):
            v = grid[r][c]
            if v >= 0:
                s = sums[v]; s[0] += r; s[1] += c; s[2] += 1
    best = [None] * n
    for r in range(h):
        for c in range(w):
            v = grid[r][c]
            if v < 0:
                continue
            cr, cc = sums[v][0] / sums[v][2], sums[v][1] / sums[v][2]
            score = min(dist[r][c], 5) * 100 - math.hypot(r - cr, c - cc)
            if best[v] is None or score > best[v][0]:
                best[v] = (score, r, c)
    return [[b[1], b[2]] if b else None for b in best], [s[2] for s in sums]


def is_foreign(lat, lon):
    """Rough land/sea split for cells outside Thailand (neighbouring countries vs. sea)."""
    if lat >= 16.2: return True
    if lat >= 13.6: return lon >= 98.1
    if lat >= 9.9 and 98.55 <= lon <= 99.9: return True
    if lat >= 11.4 and lon >= 102.3: return True
    if 10.4 <= lat < 11.4 and lon >= 103.1: return True
    if lat < 6.62 and 100.33 <= lon <= 102.3: return True
    if lat < 6.45 and 100.1 <= lon < 100.33: return True
    return False


def dump(path, obj, pretty=False):
    with open(path, 'w', encoding='utf-8') as f:
        if pretty:
            json.dump(obj, f, ensure_ascii=False, indent=2)
        else:
            json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
        f.write('\n')


# ---------------------------------------------------------------- country map
def build_map(features, slugs):
    W = round((LON1 - LON0) / S); H = round((LAT1 - LAT0) / S)
    grid = [[-1] * W for _ in range(H)]
    for pi, f in enumerate(features):
        for r, a, b in raster_spans(polygons(f['geometry']), LON0, LAT1, S, W, H):
            grid[r][a:b + 1] = [pi] * (b - a + 1)
    anchor, cells = anchors(grid, W, H, len(features))

    adj = [set() for _ in features]
    for r in range(H):
        for c in range(W):
            v = grid[r][c]
            if v < 0:
                continue
            for rr, cc in ((r + 1, c), (r, c + 1)):
                if rr < H and cc < W and grid[rr][cc] >= 0 and grid[rr][cc] != v:
                    adj[v].add(grid[rr][cc]); adj[grid[rr][cc]].add(v)
    shade = {}
    for v in sorted(range(len(features)), key=lambda i: -len(adj[i])):
        used = {shade[n] for n in adj[v] if n in shade}
        shade[v] = next(k for k in range(8) if k not in used)

    rows = []
    for r in range(H):
        s = []
        for c in range(W):
            v = grid[r][c]
            if v >= 0:
                s.append(CHARS[v])
            else:
                s.append(',' if is_foreign(LAT1 - (r + .5) * S, LON0 + (c + .5) * S) else '.')
        rows.append(rle(''.join(s)))
    dump(os.path.join(DATA, 'map.json'), {
        'W': W, 'H': H, 'S': S, 'lon0': LON0, 'lat1': LAT1, 'chars': ''.join(CHARS),
        'provinces': slugs, 'anchor': anchor, 'shade': [shade[i] for i in range(len(features))],
        'adj': [sorted(a) for a in adj], 'cells': cells, 'rows': rows,
    })
    print(f'map.json: {W}x{H} blocks, min province {min(cells)} blocks')
    return grid


def assign_districts(adm2, grid, ref_names):
    """Give every district shape to one province (index into th.json).

    Prefer a province (among those it touches) whose name list contains
    the shape's name, since the two boundary datasets disagree near borders; else the largest
    overlap of at least 10%.
    """
    H, W = len(grid), len(grid[0])
    res = 0.005
    owner = []
    for f, (x0, y0, x1, y1), _ in adm2:
        w = math.ceil((x1 - x0) / res) + 1
        h = math.ceil((y1 - y0) / res) + 1
        votes = {}
        for r, a, b in raster_spans(polygons(f['geometry']), x0, y1, res, w, h):
            lat = y1 - (r + .5) * res
            gr = int((LAT1 - lat) / S)
            for c in range(a, b + 1):
                gc = int((x0 + (c + .5) * res - LON0) / S)
                if 0 <= gr < H and 0 <= gc < W and grid[gr][gc] >= 0:
                    votes[grid[gr][gc]] = votes.get(grid[gr][gc], 0) + 1
        if not votes:  # tiny shape: nearest province block to its bbox centre
            cr, cc = int((LAT1 - (y0 + y1) / 2) / S), int(((x0 + x1) / 2 - LON0) / S)
            best = min(((abs(r - cr) + abs(c - cc), grid[r][c]) for r in range(max(cr - 6, 0), min(cr + 7, H))
                        for c in range(max(cc - 6, 0), min(cc + 7, W)) if grid[r][c] >= 0), default=(0, -1))
            owner.append(best[1])
        else:
            total = sum(votes.values())
            cands = [p for p, n in votes.items() if n >= 0.1 * total]
            name = norm(f['properties']['shapeName'])
            named = [p for p in votes
                     if any(SequenceMatcher(None, name, norm(n)).ratio() >= 0.85 for n in ref_names[p])]
            owner.append(max(named or cands, key=votes.get))
    return owner


# ---------------------------------------------------------------- districts
def norm(name):
    s = name.lower()
    s = re.sub(r'^(khet|amphoe|king amphoe|king-amphoe)\s+', '', s)
    s = s.replace('mueang', 'muang').replace('muea', 'mua').replace('ue', 'u')
    return re.sub(r'[^a-z]', '', s)


def match_names(geo_names, ref):
    """Greedy best-first matching of geoBoundaries names to kongvut districts."""
    pairs = []
    for gi, g in enumerate(geo_names):
        for ri, d in enumerate(ref):
            pairs.append((SequenceMatcher(None, norm(g), norm(d['name_en'])).ratio(), gi, ri))
    pairs.sort(reverse=True)
    out, used_g, used_r = {}, set(), set()
    for score, gi, ri in pairs:
        if score < 0.6 or gi in used_g or ri in used_r:
            continue
        out[gi] = ri; used_g.add(gi); used_r.add(ri)
    return out


# ---------------------------------------------------------------- district items
# Terrain-derived icons for districts without a hand-picked landmark in province.json.
REGION_FARM = {
    'C': ('rice', 'Rice', 'Lowland rice farming'),
    'N': ('rice', 'Rice', 'Valley rice farming'),
    'NE': ('sugarCane', 'Sugar Cane', 'Isan plateau farmland: sugar cane, cassava and rice'),
    'W': ('sugarCane', 'Sugar Cane', 'Sugar cane and fruit farms'),
    'E': ('berries', 'Sweet Berries', 'Fruit orchards: durian, rambutan, mangosteen'),
    'S': ('rubberTree', 'Rubber Tree', 'Rubber and oil palm plantations'),
}


def district_item(name, slug, region, curated, stats):
    """Pick {name, sprite, note, kind} for one district."""
    if name in curated:
        c = curated[name]
        return {'name': c['item'], 'sprite': c['sprite'], 'note': c['note'], 'kind': 'landmark'}
    elev, coastal, island = stats
    e = f'average elevation about {int(round(elev, -1))} m'
    if name.startswith(('Mueang ', 'Khet Phra Nakhon')):
        return {'name': 'Town Bell', 'sprite': 'bell', 'note': 'Provincial capital district (amphoe mueang).', 'kind': 'terrain'}
    if slug == 'bangkok':
        return {'name': 'Skyscraper', 'sprite': 'tower', 'note': 'Urban district (khet) of Bangkok.', 'kind': 'terrain'}
    if island:
        return {'name': 'Beach Palm', 'sprite': 'palm', 'note': 'Island district.', 'kind': 'terrain'}
    if elev >= 700:
        return {'name': 'Stone', 'sprite': 'mountain', 'note': f'Mountain district, {e}.', 'kind': 'terrain'}
    if elev >= 300:
        return {'name': 'Spruce Sapling', 'sprite': 'tree', 'note': f'Forested hills, {e}.', 'kind': 'terrain'}
    if coastal:
        return {'name': 'Raw Fish', 'sprite': 'fish', 'note': f'Coastal district, {e}.', 'kind': 'terrain'}
    spr, item, why = REGION_FARM[region]
    return {'name': item, 'sprite': spr, 'note': f'{why}; {e}.', 'kind': 'terrain'}


def build_districts(slug, prov_feature, adm2, ref_prov, meta, heights, sea, sprite_lib):
    ppolys = polygons(prov_feature['geometry'])
    x0, y0, x1, y1 = bbox(ppolys)
    res = min(0.01, max(0.0025, math.sqrt((x1 - x0) * (y1 - y0) / 60000)))
    res = round(res, 4)
    lon0, lat1 = x0 - res, y1 + res
    w = math.ceil((x1 - lon0) / res) + 2
    h = math.ceil((lat1 - y0) / res) + 2

    inside = [bytearray(w) for _ in range(h)]
    for r, a, b in raster_spans(ppolys, lon0, lat1, res, w, h):
        inside[r][a:b + 1] = b'\x01' * (b - a + 1)

    grid = [[-1] * w for _ in range(h)]
    members = []  # geoBoundaries features that belong to this province
    for f in adm2:
        k = len(members)
        members.append(f)
        for r, a, b in raster_spans(polygons(f['geometry']), lon0, lat1, res, w, h):
            row, ins = grid[r], inside[r]
            for c in range(a, b + 1):
                if ins[c]:
                    row[c] = k
    # Fill province cells that no district covered (dataset mismatch) from the nearest district
    q = deque((r, c) for r in range(h) for c in range(w) if grid[r][c] >= 0)
    while q:
        r, c = q.popleft()
        for dr, dc in DIRS4:
            rr, cc = r + dr, c + dc
            if 0 <= rr < h and 0 <= cc < w and inside[rr][cc] and grid[rr][cc] < 0:
                grid[rr][cc] = grid[r][c]
                q.append((rr, cc))

    ref = [d for d in (ref_prov['districts'] if ref_prov else []) if not d.get('deleted_at')]
    geo_names = [f['properties']['shapeName'] for f in members]
    matched = match_names(geo_names, ref)
    anc, cells = anchors(grid, w, h, len(members))

    # Per-district terrain stats from the country block grid: mean elevation, coast, island
    Hc, Wc = len(sea), len(sea[0])
    acc = [[0.0, 0, 0, 0] for _ in members]  # elev sum, cells, coastal cells, cells over sea blocks
    for r in range(h):
        lat = lat1 - (r + .5) * res
        gr = min(max(int((LAT1 - lat) / S), 0), Hc - 1)
        for c in range(w):
            v = grid[r][c]
            if v < 0:
                continue
            gc = min(max(int((lon0 + (c + .5) * res - LON0) / S), 0), Wc - 1)
            a = acc[v]
            a[0] += max(heights[gr][gc], 0); a[1] += 1
            if sea[gr][gc]:
                a[3] += 1
            elif any(0 <= gr + dr < Hc and 0 <= gc + dc < Wc and sea[gr + dr][gc + dc] for dr, dc in DIRS4):
                a[2] += 1
    stats = [(a[0] / a[1] if a[1] else 0, a[2] + a[3] > 0, a[1] and a[3] / a[1] > .5) for a in acc]

    curated = meta[slug].get('district_items', {})
    region = meta[slug]['region']
    districts = []
    for k, f in enumerate(members):
        d = ref[matched[k]] if k in matched else None
        en = d['name_en'] if d else geo_names[k]
        districts.append({
            'id': d['id'] if d else None,
            'name': {'en': en, 'th': d['name_th'] if d else ''},
            'anchor': anc[k], 'cells': cells[k],
            'elevation': int(round(stats[k][0])),
            'item': district_item(en, slug, region, curated, stats[k]),
        })
    # kongvut districts without a boundary in geoBoundaries (e.g. newer amphoe): names only
    matched_ref = set(matched.values())
    extra = [{'id': d['id'], 'name': {'en': d['name_en'], 'th': d['name_th']}, 'anchor': None, 'cells': 0,
              'item': district_item(d['name_en'], slug, region, curated, (0, False, False))}
             for i, d in enumerate(ref) if i not in matched_ref]
    missing = set(curated) - {x['name']['en'] for x in districts + extra}
    if missing:
        print(f'  {slug}: district_items with unknown names: {sorted(missing)}', file=sys.stderr)
    used = {x['item']['sprite'] for x in districts + extra}
    sprites = {sid: sprite_lib[sid] for sid in sorted(used)}

    chars = [chr(c) for c in range(0x30, 0x7f) if chr(c) not in '\\`~.'] + \
            [chr(c) for c in range(0xc0, 0x250)]
    rows = [rle(''.join(chars[v] if v >= 0 else '.' for v in row)) for row in grid]
    dump(os.path.join(PROV_DIR, slug, 'districts.json'), {
        'province': slug, 'res': res, 'lon0': lon0, 'lat1': lat1, 'w': w, 'h': h,
        'chars': ''.join(chars[:len(members)]),
        'districts': districts + extra, 'sprites': sprites, 'rows': rows,
    })

    subs = {}
    for d in ref:
        subs[str(d['id'])] = [{'id': t['id'], 'name': {'en': t['name_en'], 'th': t['name_th']}, 'zip': t['zip_code']}
                              for t in d['sub_districts'] if not t.get('deleted_at')]
    dump(os.path.join(PROV_DIR, slug, 'subdistricts.json'), {'province': slug, 'districts': subs})
    return len(members), len(matched), len(ref), sum(len(v) for v in subs.values())


def main():
    th = source('th.json')['features']
    adm2_raw = source('adm2.geojson')['features']
    pds = source('pds.json')

    meta = {}
    for slug in sorted(os.listdir(PROV_DIR)):
        with open(os.path.join(PROV_DIR, slug, 'province.json'), encoding='utf-8') as f:
            meta[slug] = json.load(f)
    by_dataset = {m['dataset_name']: s for s, m in meta.items()}
    slugs = [by_dataset[f['properties']['name']] for f in th]
    grid = build_map(th, slugs)
    heights = build_elevation()
    build_roads()
    sea = [[grid[r][c] == -1 and not is_foreign(LAT1 - (r + .5) * S, LON0 + (c + .5) * S)
            for c in range(len(grid[0]))] for r in range(len(grid))]
    # district sprites: shared library plus every province's own item sprite
    with open(os.path.join(DATA, 'sprites.json'), encoding='utf-8') as f:
        sprite_lib = json.load(f)['sprites']
    for m in meta.values():
        sprite_lib.setdefault(m['item']['id'], m['item']['sprite'])

    adm2 = [(f, bbox(polygons(f['geometry'])), area(polygons(f['geometry']))) for f in adm2_raw]
    for p in pds:
        for d in p['districts']:
            d['name_en'] = NAME_FIXES.get(d['id'], d['name_en'])
    ref_by_th = {p['name_th']: p for p in pds if not p.get('deleted_at')}
    ref_names = [[d['name_en'] for d in ref_by_th.get(meta[s]['name']['th'], {}).get('districts', [])
                  if not d.get('deleted_at')] for s in slugs]
    owner = assign_districts(adm2, grid, ref_names)
    tot = [0, 0, 0, 0]
    for pi, (f, slug) in enumerate(zip(th, slugs)):
        ref = ref_by_th.get(meta[slug]['name']['th'])
        if ref is None:
            print('  no name data for', slug, file=sys.stderr)
        n_geo, n_match, n_ref, n_sub = build_districts(
            slug, f, [a[0] for a, o in zip(adm2, owner) if o == pi], ref, meta, heights, sea, sprite_lib)
        tot = [a + b for a, b in zip(tot, (n_geo, n_match, n_ref, n_sub))]
        if n_match < max(n_geo, n_ref):
            print(f'  {slug}: {n_geo} shapes, {n_ref} named, {n_match} matched')
    print(f'districts: {tot[0]} shapes, {tot[2]} named, {tot[1]} matched; subdistricts: {tot[3]}')


if __name__ == '__main__':
    main()
