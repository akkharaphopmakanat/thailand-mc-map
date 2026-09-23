#!/usr/bin/env python3
"""Regenerate the generated data files under data/.

Hand-written content lives in data/provinces/<slug>/province.json (including
optional `district_items` landmarks keyed by district English name) and
data/sprites.json; this script never touches them. It (re)writes:

  data/map.json                               province block grid for the whole country (0.005° blocks)
  data/provinces/<slug>/districts.json        amphoe / khet raster + names
  data/provinces/<slug>/subdistricts.json     tambon / khwaeng names + postcodes
  data/elevation.png                          mean height (m) per map block, land and sea (R*256+G-32768)
  data/blocks.json                            per-block layers: roads, railways, rivers (OpenStreetMap)
  data/rivers.json                            reservoirs (polygons) and main-river labels, world px

Sources (downloaded into tools/.cache on first run):
  th.json       province polygons      github.com/apisit/thailand.json
  adm2.geojson  district polygons      geoBoundaries THA ADM2 (CC BY 3.0 IGO)
  pds.json      Thai admin names       github.com/kongvut/thai-province-data (MIT)
  terrarium/    elevation tiles, z8    AWS Terrain Tiles (Mapzen terrarium encoding)
  ne_10m_lakes.geojson  reservoirs    Natural Earth lakes (public domain)
  ne_50m_admin_0_countries.geojson  neighbouring countries (land vs sea outside Thailand)
  thailand-latest.osm.pbf  roads, rail, rivers   OpenStreetMap via Geofabrik (ODbL); read with
                         pyosmium: pip install --target tools/.cache/pylib osmium
  otop_*.csv, CDD_OPC_*.csv  OTOP     Community Development Department open data (data.go.th)

Usage: python3 tools/build_data.py
"""
import json, math, os, re, sys, urllib.request
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
    'ne_10m_lakes.geojson': 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_lakes.geojson',
    'ne_50m_admin_0_countries.geojson': 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson',
    'thailand-latest.osm.pbf': 'https://download.geofabrik.de/asia/thailand-latest.osm.pbf',
    # OTOP producer register (province, district, sub-district per producer) and the
    # OTOP Product Champion star ratings (product, producer, province, category, stars)
    'otop_2026.csv': 'https://logi.cdd.go.th/opendata_cdd/2026/CDD_otop_own_2026.csv',
    'otop_2025.csv': 'https://logi.cdd.go.th/opendata_cdd/2025/CDD_otop_own_2025.csv',
    'CDD_OPC_2025.csv': 'https://logi.cdd.go.th/opendata_cdd/2025/CDD_OPC_2025.csv',
    'CDD_OPC_2024.csv': 'https://logi.cdd.go.th/opendata_cdd/2024/CDD_OPC_2024.csv',
}

# Country grid: 0.005° blocks (~550 m)
S = 0.005
LON0, LON1, LAT0, LAT1 = 97.2, 105.8, 5.4, 20.6
# Symbols used to encode province indices in map.json rows ('.' sea, ',' foreign land, '~' RLE marker)
CHARS = [chr(c) for c in range(0x21, 0x7f) if chr(c) not in '"\\`\'$~.,-'][:77]
DIRS4 = ((1, 0), (-1, 0), (0, 1), (0, -1))
# English names that are wrong in pds.json (the Thai names are right)
NAME_FIXES = {6008: 'Tha Tako', 6011: 'Lat Yao'}


def cached(name):
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        os.makedirs(CACHE, exist_ok=True)
        print('downloading', name, '...', file=sys.stderr)
        urllib.request.urlretrieve(SOURCES[name], path)
    return path


def source(name):
    with open(cached(name), encoding='utf-8') as f:
        return json.load(f)


# ---------------------------------------------------------------- elevation
TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
TILE_Z = 9  # ~0.3 km pixels, averaged down to 0.005° blocks


def tile_xy(lat, lon, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def build_elevation():
    """Mean elevation (metres, negative = sea depth) per 0.005° block, as a lossless RGB PNG:
    metres = R * 256 + G - 32768 (blue unused)."""
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
    # 2x2 samples per block, averaged
    k = 2
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
    v = heights.astype(np.int32) + 32768
    rgb = np.stack([(v >> 8).astype(np.uint8), (v & 255).astype(np.uint8), np.zeros_like(v, dtype=np.uint8)], axis=-1)
    Image.fromarray(rgb, 'RGB').save(os.path.join(DATA, 'elevation.png'), optimize=True)
    path = os.path.join(DATA, 'map.json')
    with open(path, encoding='utf-8') as f:
        m = json.load(f)
    m['elevation'] = {'file': 'elevation.png', 'unit': 'm', 'encoding': 'metres = R * 256 + G - 32768',
                      'source': 'terrarium', 'min': int(heights.min()), 'max': int(heights.max())}
    dump(path, m)
    print(f'elevation.png: {heights.min()} .. {heights.max()} m')
    return heights.astype(int).tolist()


# ---------------------------------------------------------------- roads
PX_PER_DEG = 200  # world pixels per degree: B / S in js/config.js and map.json (1 px per 0.005° block)


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


def build_rivers(labels):
    """Reservoirs (Natural Earth lakes) and river labels from the OSM main rivers, in world pixels.
    River lines themselves come from OSM (blocks.json); Natural Earth's are too coarse to overlay."""
    px = PX_PER_DEG
    to_px = lambda pts: [v for x, y in pts for v in (round((x - LON0) * px), round((LAT1 - y) * px))]
    inside = lambda pts: any(LON0 <= x <= LON1 and LAT0 <= y <= LAT1 for x, y in pts)
    rivers = []
    lakes = []
    for f in source('ne_10m_lakes.geojson')['features']:
        g, p = f['geometry'], f['properties']
        if not g:
            continue
        for poly in polygons(g):
            if not inside(poly[0]):
                continue
            lakes.append({'name': p.get('name') or '', 'rings': [to_px(simplify([(x, y) for x, y in r], 0.002)) for r in poly]})
    dump(os.path.join(DATA, 'rivers.json'), {'units': f'world px ({PX_PER_DEG} per degree)',
                                             'labels_fields': ['name', 'x', 'y', 'angle'], 'labels': labels,
                                             'rivers': rivers, 'lakes': lakes})
    print(f'rivers.json: {len(lakes)} lakes, {len(labels)} labels')


# ---------------------------------------------------------------- OpenStreetMap roads, rail, rivers
# Transport codes per block, higher wins where they meet
# 2–3 medium road (secondary, primary), 4 main road (trunk, motorway); smaller roads are left out
ROAD_CODE = {'secondary': 2, 'secondary_link': 2, 'primary': 3, 'primary_link': 3,
             'trunk': 4, 'trunk_link': 4, 'motorway': 4, 'motorway_link': 4}
RAIL_CODE = 5
# Main rivers (water code 2, drawn two blocks wide); every other river is code 1 ("small rivers").
# Matched on the whole name so Thai syllables inside stream names don't count.
_MAIN_EN = (r'Chao Phraya|Mekong|Nan|Ping|Wang|Yom|Mun|Chi|Tha Chin|Pa Sak|Pasak|Bang Pakong|Mae ?Klong|'
            r'Tapi|Songkhram|Salween|Moei|Khwae Noi|Khwae Yai|Kwai Noi|Kwai Yai|Lop Buri|Noi|Prachin Buri|'
            r'Phetchaburi|Pattani|Kok|Ing|Loei|Lam Pao|Lam Takhong|Suphan|Sakae Krang|Chanthaburi|Trang|Pai|Yuam|Kuang|Li')
_MAIN_TH = (r'เจ้าพระยา|โขง|น่าน|ปิง|วัง|ยม|มูล|ชี|ท่าจีน|ป่าสัก|บางปะกง|แม่กลอง|ตาปี|สงคราม|สาละวิน|เมย|แควน้อย|แควใหญ่|'
            r'ลพบุรี|น้อย|ปราจีนบุรี|เพชรบุรี|ปัตตานี|กก|อิง|เลย|ลำปาว|ลำตะคอง|สุพรรณบุรี|สะแกกรัง|จันทบุรี|ตรัง|ปาย|ยวม|กวง|ลี้')
MAIN_EN = re.compile(rf'^(Mae Nam |Maenam )?({_MAIN_EN})( River)?$', re.I)
MAIN_TH = re.compile(rf'^(แม่น้ำ|น้ำ|ลำน้ำ)({_MAIN_TH})$')


def is_main_river(tags):
    """Thai name decides when there is one (English tags are sometimes wrong, e.g. the Mae Wang
    canal in Chiang Mai is tagged 'Wang River'); otherwise the English name."""
    th = (tags.get('name') or '').strip()
    if any('\u0e00' <= ch <= '\u0e7f' for ch in th):
        return bool(MAIN_TH.match(th))
    return bool(MAIN_EN.match((tags.get('name:en') or '').strip()))


TRANSPORT_NAMES = {2: 'medium road: secondary (cobblestone)', 3: 'medium road: primary (cobblestone)',
                   4: 'main road: trunk, motorway (stone, centre line)', 5: 'railway (rails)'}


def build_transport(W, H):
    """Rasterise OSM highways (tertiary and up), railways and rivers onto the block grid."""
    sys.path.insert(0, os.path.join(CACHE, 'pylib'))
    import osmium
    road = [bytearray(W) for _ in range(H)]
    water = [bytearray(W) for _ in range(H)]

    def line(coords, layer, code, wide=False):
        cells = [(int((LAT1 - lat) / S), int((lon - LON0) / S)) for lon, lat in coords]
        if wide:   # a second, offset pass makes the line two blocks wide
            line([(lon + S, lat) for lon, lat in coords], layer, code)
            line([(lon, lat - S) for lon, lat in coords], layer, code)
        for (r0, c0), (r1, c1) in zip(cells, cells[1:]):
            dr, dc = abs(r1 - r0), -abs(c1 - c0)
            sr, sc = (1 if r0 < r1 else -1), (1 if c0 < c1 else -1)
            err = dr + dc
            while True:
                if 0 <= r0 < H and 0 <= c0 < W and layer[r0][c0] < code:
                    layer[r0][c0] = code
                if r0 == r1 and c0 == c1:
                    break
                # one axis per step, so lines are 4-connected staircases (rails and roads join up)
                e2 = 2 * err
                if e2 >= dc and (e2 - dc <= dr - e2 or c0 == c1):
                    err += dc; r0 += sr
                else:
                    err += dr; c0 += sc

    n = {'road': 0, 'rail': 0, 'river': 0, 'main': 0}
    main_pts = {}                              # river name -> [(lon, lat, angle°)] for labels
    fp = osmium.FileProcessor(cached('thailand-latest.osm.pbf'), osmium.osm.NODE | osmium.osm.WAY) \
        .with_locations().with_filter(osmium.filter.KeyFilter('highway', 'railway', 'waterway'))
    for w in fp:
        if not w.is_way():
            continue
        t = w.tags
        hw, rw, ww = t.get('highway'), t.get('railway'), t.get('waterway')
        if hw in ROAD_CODE:
            layer, code, kind = road, ROAD_CODE[hw], 'road'
        elif rw == 'rail' and t.get('service') is None:
            layer, code, kind = road, RAIL_CODE, 'rail'
        elif ww == 'river':
            main = is_main_river(t)
            layer, code, kind = water, 2 if main else 1, 'river'
        else:
            continue
        try:
            coords = [(nd.lon, nd.lat) for nd in w.nodes if nd.location.valid()]
        except osmium.InvalidLocationError:
            continue
        if len(coords) >= 2 and any(LON0 <= x <= LON1 and LAT0 <= y <= LAT1 for x, y in coords):
            line(coords, layer, code, kind == 'river' and code == 2)
            n[kind] += 1
            if kind == 'river' and code == 2 and len(coords) >= 3:
                name = river_label(t)
                if name:
                    for (x0, y0), (x1, y1) in zip(coords[::4], coords[2::4]):
                        main_pts.setdefault(name, []).append(((x0 + x1) / 2, (y0 + y1) / 2,
                                                              math.degrees(math.atan2(y1 - y0, x1 - x0))))
            n['main'] += kind == 'river' and code == 2
    dump(os.path.join(DATA, 'blocks.json'), {
        'W': W, 'H': H, 'source': 'roads/water: OpenStreetMap contributors (ODbL), via Geofabrik',
        'road_codes': {str(k): v for k, v in TRANSPORT_NAMES.items()},
        'roads': [rle(''.join('.12345'[v] for v in row)) for row in road],
        'water_codes': {'1': 'small river', '2': 'main river'},
        'water': [rle(''.join('.12'[v] for v in row)) for row in water],
    })
    print(f"blocks.json: {n['road']} road ways, {n['rail']} rail ways, {n['river']} river ways ({n['main']} main)")
    # River labels on the drawn (OSM) main rivers: repeat along a river, at least ~0.9° apart
    labels = []
    for name, pts in sorted(main_pts.items()):
        pts.sort(key=lambda p: h2key(p[0], p[1]))            # deterministic spread, not map order
        kept = []
        for lon, lat, ang in pts:
            if LON0 <= lon <= LON1 and LAT0 <= lat <= LAT1 and all(math.hypot(lon - a, lat - b) > 0.9 for a, b, _ in kept):
                kept.append((lon, lat, ang))
        for lon, lat, ang in kept:
            labels.append([name, round((lon - LON0) * PX_PER_DEG, 1), round((LAT1 - lat) * PX_PER_DEG, 1), round(ang, 1)])
    print(f'river labels: {len(labels)} for {len(main_pts)} main rivers')
    return labels


def h2key(x, y):
    """Stable pseudo-random order for label candidates."""
    return math.sin(x * 12.9898 + y * 78.233) * 43758.5453 % 1


def river_label(tags):
    """English display name for a main river, e.g. 'Nan River' (from the Thai name when present)."""
    th = (tags.get('name') or '').strip()
    m = MAIN_TH.match(th)
    if m:
        return TH_TO_EN.get(m.group(2), m.group(2)) + ' River'
    m = MAIN_EN.match((tags.get('name:en') or '').strip())
    return m.group(2).title().strip() + ' River' if m else ''


TH_TO_EN = {'เจ้าพระยา': 'Chao Phraya', 'โขง': 'Mekong', 'น่าน': 'Nan', 'ปิง': 'Ping', 'วัง': 'Wang', 'ยม': 'Yom',
            'มูล': 'Mun', 'ชี': 'Chi', 'ท่าจีน': 'Tha Chin', 'ป่าสัก': 'Pa Sak', 'บางปะกง': 'Bang Pakong',
            'แม่กลอง': 'Mae Klong', 'ตาปี': 'Tapi', 'สงคราม': 'Songkhram', 'สาละวิน': 'Salween', 'เมย': 'Moei',
            'แควน้อย': 'Khwae Noi', 'แควใหญ่': 'Khwae Yai', 'ลพบุรี': 'Lop Buri', 'น้อย': 'Noi',
            'ปราจีนบุรี': 'Prachin Buri', 'เพชรบุรี': 'Phetchaburi', 'ปัตตานี': 'Pattani', 'กก': 'Kok', 'อิง': 'Ing',
            'เลย': 'Loei', 'ลำปาว': 'Lam Pao', 'ลำตะคอง': 'Lam Takhong', 'สุพรรณบุรี': 'Suphan',
            'สะแกกรัง': 'Sakae Krang', 'จันทบุรี': 'Chanthaburi', 'ตรัง': 'Trang', 'ปาย': 'Pai', 'ยวม': 'Yuam',
            'กวง': 'Kuang', 'ลี้': 'Li'}


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


def foreign_mask(grid):
    """True for non-Thai land blocks: inside a neighbouring country's outline (Natural Earth),
    or any non-Thai block the open sea cannot reach (gaps where the two border datasets differ)."""
    H, W = len(grid), len(grid[0])
    mask = [[False] * W for _ in range(H)]
    for f in source('ne_50m_admin_0_countries.geojson')['features']:
        if f['properties'].get('ADM0_A3') == 'THA' or not f['geometry']:
            continue
        polys = polygons(f['geometry'])
        x0, y0, x1, y1 = bbox(polys)
        if x1 < LON0 or x0 > LON1 or y1 < LAT0 or y0 > LAT1:
            continue
        for r, a, b in raster_spans(polys, LON0, LAT1, S, W, H):
            mask[r][a:b + 1] = [True] * (b - a + 1)
    # Sea = non-Thai, non-foreign blocks connected to open water (seeded in the Andaman Sea and the Gulf)
    sea = [[False] * W for _ in range(H)]
    seeds = [(8.0, 97.4), (9.5, 101.5), (7.0, 102.5)]
    q = deque()
    for lat, lon in seeds:
        r, c = int((LAT1 - lat) / S), int((lon - LON0) / S)
        if grid[r][c] == -1 and not mask[r][c]:
            sea[r][c] = True
            q.append((r, c))
    while q:
        r, c = q.popleft()
        for dr, dc in DIRS4:
            rr, cc = r + dr, c + dc
            if 0 <= rr < H and 0 <= cc < W and not sea[rr][cc] and grid[rr][cc] == -1 and not mask[rr][cc]:
                sea[rr][cc] = True
                q.append((rr, cc))
    for r in range(H):
        for c in range(W):
            if grid[r][c] == -1 and not sea[r][c]:
                mask[r][c] = True
    return mask


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

    foreign = foreign_mask(grid)
    rows = []
    for r in range(H):
        s = []
        for c in range(W):
            v = grid[r][c]
            s.append(CHARS[v] if v >= 0 else ',' if foreign[r][c] else '.')
        rows.append(rle(''.join(s)))
    dump(os.path.join(DATA, 'map.json'), {
        'W': W, 'H': H, 'S': S, 'lon0': LON0, 'lat1': LAT1, 'chars': ''.join(CHARS),
        'provinces': slugs, 'anchor': anchor, 'shade': [shade[i] for i in range(len(features))],
        'adj': [sorted(a) for a in adj], 'cells': cells, 'rows': rows,
    })
    print(f'map.json: {W}x{H} blocks, min province {min(cells)} blocks')
    return grid, foreign


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
            rad = max(6, round(0.25 / S))  # search ~0.25° around it
            best = min(((abs(r - cr) + abs(c - cc), grid[r][c]) for r in range(max(cr - rad, 0), min(cr + rad + 1, H))
                        for c in range(max(cc - rad, 0), min(cc + rad + 1, W)) if grid[r][c] >= 0), default=(0, -1))
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


# ---------------------------------------------------------------- OTOP products
# Product types matched against the Thai product name, most specific first:
# (id, regex, English item name, sprite)
OTOP_TYPES = [
    ('fiber', r'เชือกกล้วย|ใยกล้วย|กาบกล้วย|ใยสับปะรด|เส้นใย', 'Woven Basket', 'kratip'),
    ('dried_banana', r'กล้วยตาก|กล้วยอบ', 'Dried Banana', 'banana'),
    ('banana', r'กล้วย', 'Banana Snack', 'banana'),
    ('coffee', r'กาแฟ', 'Coffee', 'coffee'),
    ('tea', r'^ชา|ชา(เขียว|ดำ|อู่หลง|ใบ|มะรุม|ตะไคร้|กุหลาบ|ดอก|ไทย|สมุนไพร|หม่อน)|ใบชา', 'Tea', 'tea'),
    ('rice_cracker', r'ข้าวแต๋น|ข้าวเกรียบ|ข้าวพอง|ข้าวตัง', 'Rice Cracker', 'cookie'),
    ('rice', r'ข้าว(หอม|กล้อง|สาร|ไรซ์|เหนียว|เจ้า|ฮาง|ซ้อมมือ|มะลิ|หอมมะลิ|สังข์หยด|ก่ำ|ไร)|ข้าว\s', 'Rice', 'rice'),
    ('honey', r'น้ำผึ้ง|ผึ้ง', 'Honey Bottle', 'honeyBottle'),
    ('mushroom', r'เห็ด', 'Mushroom', 'mushroom'),
    ('silk', r'ไหม', 'Silk', 'silk'),
    ('indigo', r'คราม|ม่อฮ่อม|หม้อห้อม|หม้อฮ่อม', 'Indigo Cloth', 'indigoShirt'),
    ('bag', r'กระเป๋า', 'Bag', 'bundle'),
    ('cloth', r'ผ้า|บาติก|ฝ้าย|มัดย้อม|ขาวม้า|เสื้อ|ซิ่น', 'Woven Cloth', 'cloth'),
    ('basket', r'จักสาน|สาน|ตะกร้า|กระติ๊บ|กระติบ|เสื่อ|หวาย|กระจูด|ผักตบ', 'Woven Basket', 'kratip'),
    ('pottery', r'ดินเผา|ปั้น|เซรามิ|โอ่ง|แจกัน|เบญจรงค์|ศิลาดล|ดินเผา', 'Pottery', 'jar'),
    ('jewelry', r'เครื่องเงิน|เครื่องประดับ|สร้อย|แหวน|ต่างหู|กำไล|ไข่มุก|มุก|พลอย|ทองเหลือง|เงินแท้', 'Jewelry', 'ring'),
    ('soap', r'สบู่|แชมพู|ครีม|โลชั่น|เซรั่ม|สครับ|ลิป', 'Soap', 'soap'),
    ('herbal', r'สมุนไพร|ยาหม่อง|น้ำมันนวด|ลูกประคบ|ยาดม|น้ำมันเหลือง|บาล์ม|กระชาย|ขมิ้น|ฟ้าทะลาย', 'Herbal Potion', 'potion'),
    ('chili', r'น้ำพริก|พริกแกง|เครื่องแกง|แจ่ว|พริก', 'Chili Paste', 'chili'),
    ('sauce', r'ซอส|น้ำจิ้ม|น้ำปลา|น้ำบูดู|บูดู', 'Sauce', 'sauce'),
    ('shrimp', r'กะปิ|กุ้ง', 'Shrimp', 'shrimp'),
    ('fish', r'ปลา|หมึก|ปู', 'Fish', 'fish'),
    ('pork', r'แหนม|ไส้กรอก|หมูยอ|กุนเชียง|ไส้อั่ว|หมู|เนื้อ|แคบ', 'Sausage', 'sausage'),
    ('mango', r'มะม่วง', 'Mango', 'mango'),
    ('durian', r'ทุเรียน', 'Durian', 'durian'),
    ('longan', r'ลำไย', 'Longan', 'longan'),
    ('coconut', r'มะพร้าว', 'Coconut', 'coconut'),
    ('pineapple', r'สับปะรด|สัปปะรด', 'Pineapple', 'pineapple'),
    ('tamarind', r'มะขาม', 'Tamarind', 'tamarind'),
    ('pomelo', r'ส้มโอ', 'Pomelo', 'pomelo'),
    ('orange', r'ส้ม(?!ตำ)|มะนาว', 'Citrus', 'orange'),
    ('berries', r'สตรอ|ลิ้นจี่|มังคุด|เงาะ|มัลเบอร์รี่|หม่อน|ผลไม้', 'Fruit', 'berries'),
    ('sugar', r'น้ำตาล|ตาลโตนด', 'Palm Sugar', 'palmSugar'),
    ('salt', r'เกลือ', 'Salt', 'salt'),
    ('liquor', r'สุรา|ไวน์|กระแช่|สาโท|เหล้า|ข้าวหมาก', 'Rice Wine', 'bottle'),
    ('noodles', r'เส้น|ก๋วยเตี๋ยว|ขนมจีน|หมี่', 'Noodles', 'bowl'),
    ('snack', r'ขนม|คุกกี้|เค้ก|ทองม้วน|ข้าวต้มมัด|กาละแม|กระยาสารท|ถั่ว|เปี๊ยะ|ทองหยอด|ทองพับ|บราวนี่|เบเกอรี่|โรตี|งา', 'Snack', 'cookie'),
    ('flowers', r'ดอกไม้|มาลัย', 'Flowers', 'tulip'),
    ('candle', r'เทียน|ธูป', 'Candle', 'candle'),
    ('umbrella', r'ร่ม', 'Umbrella', 'umbrella'),
    ('knife', r'มีด|ดาบ|จอบ|เสียม', 'Iron Blade', 'sword'),
    ('bamboo', r'ไผ่', 'Bamboo', 'sugarCane'),
    ('wood', r'(?<!ผล)ไม้|แกะสลัก', 'Wood Carving', 'oakLog'),
]
# Fallback by OTOP category when no keyword matches
OTOP_CATEGORY = [
    (r'เครื่องดื่ม', ('drink', 'Juice Bottle', 'bottle')),
    (r'อาหาร', ('food', 'Local Food', 'bowl')),
    (r'ผ้า', ('cloth', 'Woven Cloth', 'cloth')),
    (r'สมุนไพร', ('herbal', 'Herbal Potion', 'potion')),
    (r'ของใช้|ของตกแต่ง|ของที่ระลึก', ('craft', 'Handicraft', 'kratip')),
]
STAR_WEIGHT = {5: 5, 4: 4, 3: 2, 2: 1, 1: .5}


def thai_key(s):
    """Normalise a Thai admin name for matching (drop prefixes and spaces)."""
    s = re.sub(r'\s+', '', s or '')
    return re.sub(r'^(อำเภอ|อ\.|กิ่งอำเภอ|จังหวัด|จ\.)', '', s)


def otop_type(product, category):
    for tid, rx, en, spr in OTOP_TYPES:
        if re.search(rx, product):
            return tid, en, spr, 1.0
    for rx, (tid, en, spr) in OTOP_CATEGORY:
        if re.search(rx, category):
            return tid, en, spr, .5   # generic types count half
    return 'craft', 'Handicraft', 'kratip', .5


def build_otop():
    """(province_th, district_th) -> best OTOP product type for that district.

    Products (OTOP Product Champion ratings) are linked to a district through the producer
    register, matched on province + producer name. Producer names are never written out.
    """
    import csv
    def rows(name):
        with open(cached(name), encoding='utf-8-sig', errors='replace') as f:
            r = csv.reader(f)
            next(r)
            yield from r
    register = {}
    for name in ('otop_2026.csv', 'otop_2025.csv'):
        for r in rows(name):
            if len(r) >= 4:
                register.setdefault((thai_key(r[0]), thai_key(r[3])), (thai_key(r[1]), r[2].strip()))
    products, seen = {}, set()
    for name in ('CDD_OPC_2025.csv', 'CDD_OPC_2024.csv'):
        for r in rows(name):
            if len(r) < 5 or not r[0].strip():
                continue
            product, producer, prov, cat = r[0].strip(), thai_key(r[1]), thai_key(r[2]), r[3].strip()
            if (product, producer) in seen:
                continue
            seen.add((product, producer))
            loc = register.get((prov, producer))
            if not loc:
                continue
            stars = int(re.sub(r'\D', '', r[4]) or 0)
            products.setdefault((prov, loc[0]), []).append((product, stars, cat, loc[1]))
    # Score each type by star-weighted count x rarity nationwide (TF-IDF style), so a district
    # is labelled by what is distinctive about it rather than by clothing, which is everywhere.
    typed = {key: [(otop_type(pr, cat), pr, st, tb) for pr, st, cat, tb in items] for key, items in products.items()}
    nationwide = {}
    for items in typed.values():
        for (tid, *_), *_ in items:
            nationwide[tid] = nationwide.get(tid, 0) + 1
    total = sum(nationwide.values())
    idf = {tid: math.log(total / n) for tid, n in nationwide.items()}
    best = {}
    for key, items in typed.items():
        score, members = {}, {}
        for (tid, en, spr, w), product, stars, tambon in items:
            score[tid] = score.get(tid, 0) + STAR_WEIGHT.get(stars, .5) * w
            members.setdefault(tid, (en, spr, []))[2].append((stars, product, tambon))
        # need at least two products (or the only type) to be the district's signature
        for tid in score:
            n = len(members[tid][2])
            score[tid] *= idf[tid] * (1 if n >= 2 or len(score) == 1 else .4)
        tid = max(score, key=score.get)
        en, spr, group = members[tid]
        stars, product, tambon = max(group, key=lambda g: (g[0], -len(g[1])))
        tambon = re.sub(r'^(ตำบล|ต\.)', '', tambon)
        best[key] = {'type': tid, 'name': en, 'sprite': spr, 'example': product, 'stars': stars,
                     'tambon': tambon, 'count': len(group), 'total': len(items)}
    print(f'otop: {sum(len(v) for v in products.values())} products linked to {len(best)} districts')
    return best


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


def district_item(name, slug, region, curated, stats, otop=None):
    """Pick {name, sprite, note, kind} for one district: its OTOP product type, else a
    hand-picked landmark, else an item from terrain."""
    if otop:
        star = f"{otop['stars']}★ " if otop['stars'] else ''
        return {'name': otop['name'], 'sprite': otop['sprite'], 'kind': 'otop',
                'note': f"OTOP: {otop['count']} of {otop['total']} rated products here are {otop['name'].lower()}. "
                        f"Example: {otop['example']} ({star}{otop['tambon'] if otop['tambon'].startswith('แขวง') else 'ต.' + otop['tambon']}).",
                'otop': {k: otop[k] for k in ('type', 'example', 'stars', 'tambon', 'count', 'total')}}
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


def landmark(name, curated):
    c = curated.get(name)
    return {'name': c['item'], 'sprite': c['sprite'], 'note': c['note']} if c else None


def build_districts(slug, prov_feature, adm2, ref_prov, meta, heights, sea, sprite_lib, otop):
    ppolys = polygons(prov_feature['geometry'])
    x0, y0, x1, y1 = bbox(ppolys)
    res = min(S, max(0.0025, math.sqrt((x1 - x0) * (y1 - y0) / 60000)))
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
    prov_th = thai_key(meta[slug]['name']['th'])
    otop_for = lambda th: otop.get((prov_th, thai_key(th)))
    districts = []
    for k, f in enumerate(members):
        d = ref[matched[k]] if k in matched else None
        en = d['name_en'] if d else geo_names[k]
        districts.append({
            'id': d['id'] if d else None,
            'name': {'en': en, 'th': d['name_th'] if d else ''},
            'anchor': anc[k], 'cells': cells[k],
            'elevation': int(round(stats[k][0])),
            'item': district_item(en, slug, region, curated, stats[k], otop_for(d['name_th']) if d else None),
            'landmark': landmark(en, curated),
        })
    # kongvut districts without a boundary in geoBoundaries (e.g. newer amphoe): names only
    matched_ref = set(matched.values())
    extra = [{'id': d['id'], 'name': {'en': d['name_en'], 'th': d['name_th']}, 'anchor': None, 'cells': 0,
              'item': district_item(d['name_en'], slug, region, curated, (0, False, False), otop_for(d['name_th'])),
              'landmark': landmark(d['name_en'], curated)}
             for i, d in enumerate(ref) if i not in matched_ref]
    missing = set(curated) - {x['name']['en'] for x in districts + extra}
    if missing:
        print(f'  {slug}: district_items with unknown names: {sorted(missing)}', file=sys.stderr)
    used = {x['item']['sprite'] for x in districts + extra} | {x['landmark']['sprite'] for x in districts + extra if x['landmark']}
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
    grid, foreign = build_map(th, slugs)
    heights = build_elevation()
    labels = build_transport(len(grid[0]), len(grid))
    build_rivers(labels)
    otop = build_otop()
    sea = [[grid[r][c] == -1 and not foreign[r][c] for c in range(len(grid[0]))] for r in range(len(grid))]
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
            slug, f, [a[0] for a, o in zip(adm2, owner) if o == pi], ref, meta, heights, sea, sprite_lib, otop)
        tot = [a + b for a, b in zip(tot, (n_geo, n_match, n_ref, n_sub))]
        if n_match < max(n_geo, n_ref):
            print(f'  {slug}: {n_geo} shapes, {n_ref} named, {n_match} matched')
    print(f'districts: {tot[0]} shapes, {tot[2]} named, {tot[1]} matched; subdistricts: {tot[3]}')



if __name__ == '__main__':
    main()
