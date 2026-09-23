#!/usr/bin/env python3
"""Regenerate the generated data files under data/.

Hand-written content lives in data/provinces/<slug>/province.json and is never
touched by this script. It (re)writes:

  data/map.json                               province block grid for the whole country
  data/provinces/<slug>/districts.json        amphoe / khet raster + names
  data/provinces/<slug>/subdistricts.json     tambon / khwaeng names + postcodes

Sources (downloaded into tools/.cache on first run):
  th.json       province polygons      github.com/apisit/thailand.json
  adm2.geojson  district polygons      geoBoundaries THA ADM2 (CC BY 3.0 IGO)
  pds.json      Thai admin names       github.com/kongvut/thai-province-data (MIT)

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
}

# Country grid: 0.04° blocks (~4.4 km)
S = 0.04
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


def build_districts(slug, prov_feature, adm2, ref_prov):
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

    districts, symbols = [], []
    for k, f in enumerate(members):
        d = ref[matched[k]] if k in matched else None
        districts.append({
            'id': d['id'] if d else None,
            'name': {'en': d['name_en'] if d else geo_names[k], 'th': d['name_th'] if d else ''},
            'anchor': anc[k], 'cells': cells[k],
        })
    # kongvut districts without a boundary in geoBoundaries (e.g. newer amphoe): names only
    matched_ref = set(matched.values())
    extra = [{'id': d['id'], 'name': {'en': d['name_en'], 'th': d['name_th']}, 'anchor': None, 'cells': 0}
             for i, d in enumerate(ref) if i not in matched_ref]

    chars = [chr(c) for c in range(0x30, 0x7f) if chr(c) not in '\\`~.'] + \
            [chr(c) for c in range(0xc0, 0x250)]
    rows = [rle(''.join(chars[v] if v >= 0 else '.' for v in row)) for row in grid]
    dump(os.path.join(PROV_DIR, slug, 'districts.json'), {
        'province': slug, 'res': res, 'lon0': lon0, 'lat1': lat1, 'w': w, 'h': h,
        'chars': ''.join(chars[:len(members)]),
        'districts': districts + extra, 'rows': rows,
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
            slug, f, [a[0] for a, o in zip(adm2, owner) if o == pi], ref)
        tot = [a + b for a, b in zip(tot, (n_geo, n_match, n_ref, n_sub))]
        if n_match < max(n_geo, n_ref):
            print(f'  {slug}: {n_geo} shapes, {n_ref} named, {n_match} matched')
    print(f'districts: {tot[0]} shapes, {tot[2]} named, {tot[1]} matched; subdistricts: {tot[3]}')


if __name__ == '__main__':
    main()
