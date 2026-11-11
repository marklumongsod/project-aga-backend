"""Build the backend seed files from the raw Team C dataset.

Reads   data/raw/GROUP_C_DATASET.xlsx, data/raw/assessment_center_points.geojson,
        data/geo/** (PSGC 2023, faeldon/philippines-json-maps)
Writes  database/seed-data/*.json  (loaded by `npm run db:seed`)

Privacy: no learner-level personal data is read or written. The T2MIS Student Profile
and TSP sheets are never read.

Run:  python -I etl/build_seed.py      (needs: shapely openpyxl)
"""
import collections
import datetime as dt
import glob
import json
import math
import os
import re
import sys

import openpyxl
from shapely.geometry import Point, mapping, shape
from shapely.ops import unary_union
from shapely.strtree import STRtree

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'data', 'raw')
GEO = os.path.join(ROOT, 'data', 'geo')
OUT = os.path.join(ROOT, 'database', 'seed-data')
os.makedirs(OUT, exist_ok=True)


def psgc(n):
    """PSGC codes are 10-digit strings with leading zeros (e.g. 0700000000)."""
    return str(int(n)).zfill(10)


def norm(s):
    s = str(s or '').lower().replace('ñ', 'n')
    s = re.sub(r'\(.*?\)', '', s)
    s = s.replace('city of ', '').replace(' city', '')
    return re.sub(r'[^a-z0-9]', '', s)


def r6(x):
    return round(float(x), 6)


def geom_json(g, tol=0.0005):
    g = g.simplify(tol, preserve_topology=True)
    if g.geom_type == 'Polygon':
        g = shape({'type': 'MultiPolygon', 'coordinates': [mapping(g)['coordinates']]})
    m = mapping(g)
    m['coordinates'] = json.loads(json.dumps(m['coordinates'], default=float), parse_float=lambda v: round(float(v), 5))
    return m


def dump(name, rows):
    with open(os.path.join(OUT, name), 'w') as f:
        json.dump(rows, f, ensure_ascii=False, separators=(',', ':'), default=str)
    print(f'  {name:28s} {len(rows):>6} rows', file=sys.stderr)


def epoch(v):
    if isinstance(v, dt.datetime):
        return int(v.replace(tzinfo=dt.timezone.utc).timestamp())
    if isinstance(v, str):
        m = re.match(r'(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?', v.strip())
        if m:
            y, mo, d, h, mi, s = (int(x) if x else 0 for x in m.groups())
            return int(dt.datetime(y, mo, d, h, mi, s, tzinfo=dt.timezone.utc).timestamp())
    return None


def num(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- geography
print('geography', file=sys.stderr)
reg_feats = json.load(open(os.path.join(GEO, 'country.json')))['features']
regions = {psgc(f['properties']['adm1_psgc']): dict(name=f['properties']['adm1_en'], geom=shape(f['geometry'])) for f in reg_feats}
provinces = {}
for fn in glob.glob(os.path.join(GEO, 'regions', '*.json')):
    for f in json.load(open(fn))['features']:
        p = f['properties']
        name = p['adm2_en'] or ('Special Geographic Area (BARMM)' if psgc(p['adm2_psgc']) == '1909900000' else psgc(p['adm2_psgc']))
        provinces[psgc(p['adm2_psgc'])] = dict(name=name, region=psgc(p['adm1_psgc']), geom=shape(f['geometry']))
cities = []
for fn in glob.glob(os.path.join(GEO, 'municities', '*.json')):
    for f in json.load(open(fn)).get('features', []):
        if not f.get('geometry'):
            continue
        p = f['properties']
        cities.append(dict(psgc=psgc(p['adm3_psgc']), name=p['adm3_en'], province=psgc(p['adm2_psgc']),
                           region=psgc(p['adm1_psgc']), geom=shape(f['geometry']), derived=False))

# Highly urbanized / independent cities are missing from the 2023 municity files.
# They are the parts of a region polygon not covered by any province; name each part
# from a reference point. PSGC code left null (not guessed); province = the province
# the city is geographically inside or next to (used to split province-level BSRS).
HUC_POINTS = [
    ('City of Baguio', 16.4120, 120.5960), ('City of Angeles', 15.1450, 120.5887), ('City of Olongapo', 14.8292, 120.2828),
    ('City of Lucena', 13.9373, 121.6170), ('City of Puerto Princesa', 9.7392, 118.7353), ('City of Iloilo', 10.7202, 122.5621),
    ('City of Bacolod', 10.6765, 122.9509), ('City of Cebu', 10.3157, 123.8854), ('City of Lapu-Lapu', 10.3103, 123.9494),
    ('City of Mandaue', 10.3236, 123.9223), ('City of Tacloban', 11.2444, 125.0039), ('City of Ormoc', 11.0064, 124.6075),
    ('City of Zamboanga', 6.9214, 122.0790), ('City of Isabela', 6.7085, 121.9711), ('City of Cagayan de Oro', 8.4542, 124.6319),
    ('City of Iligan', 8.2280, 124.2452), ('City of General Santos', 6.1164, 125.1716), ('City of Butuan', 8.9475, 125.5406),
    ('City of Cotabato', 7.2236, 124.2464), ('City of Naga', 13.6218, 123.1948), ('City of Davao', 7.0731, 125.6128),
    ('City of Santiago', 16.6875, 121.5487), ('City of Dagupan', 16.0433, 120.3333),
]
present = {norm(c['name']) for c in cities}
todo = [(n, Point(lon, lat)) for n, lat, lon in HUC_POINTS if norm(n) not in present]
munis_by_prov = collections.defaultdict(list)
for c in cities:
    munis_by_prov[c['province']].append(c['geom'])
pieces = collections.defaultdict(list)   # huc name -> [(geom, province, region)]
for pk, pv in provinces.items():
    if not pv['name']:
        continue
    rest = pv['geom'].difference(unary_union([g.buffer(0.0008) for g in munis_by_prov[pk]]))
    for part in [p for p in getattr(rest, 'geoms', [rest]) if not p.is_empty and p.area > 0.0003]:
        near = [(n, pt) for n, pt in todo if part.distance(pt) < 0.08]
        if not near:
            continue
        if len(near) == 1:
            pieces[near[0][0]].append((part, pk, pv['region']))
            continue
        # several cities share one hole (e.g. Cebu City + Mandaue): split it between their points
        from shapely.ops import voronoi_diagram
        from shapely.geometry import MultiPoint
        cells = voronoi_diagram(MultiPoint([pt for _, pt in near]), envelope=part.envelope.buffer(0.2))
        for cell in cells.geoms:
            n = next(n for n, pt in near if cell.contains(pt))
            pieces[n].append((cell.intersection(part), pk, pv['region']))
derived = 0
for n, ps in pieces.items():
    g = unary_union([p for p, _, _ in ps])
    if g.is_empty or g.area < 0.0003:
        continue
    cities.append(dict(psgc=None, name=n, province=ps[0][1], region=ps[0][2], geom=g, derived=True))
    derived += 1
print(f'  derived {derived} HUC/ICC boundaries: {sorted(pieces)}', file=sys.stderr)

# islands: connected land masses (a ferry is needed to cross between them)
land = unary_union([c['geom'].buffer(0.01) for c in cities])
islands = sorted(getattr(land, 'geoms', [land]), key=lambda g: -g.area)
itree = STRtree(islands)


def island_of(pt):
    for i in itree.query(pt):
        if islands[int(i)].contains(pt):
            return int(i)
    return int(itree.nearest(pt))


ctree = STRtree([c['geom'] for c in cities])


def city_of(pt):
    for i in ctree.query(pt):
        if cities[int(i)]['geom'].contains(pt):
            return cities[int(i)]
    i = int(ctree.nearest(pt))
    return cities[i] if cities[i]['geom'].distance(pt) < 0.05 else None


for i, c in enumerate(cities):
    c['key'] = c['psgc'] or f"D-{c['region'][:2]}-{norm(c['name'])}"
    c['pt'] = c['geom'].representative_point()
    c['island'] = island_of(c['pt'])

dump('regions.json', [dict(psgc=k, name=v['name'], geometry=geom_json(v['geom'], 0.002)) for k, v in sorted(regions.items())])
dump('provinces.json', [dict(psgc=k, name=v['name'], regionPsgc=v['region'], geometry=geom_json(v['geom'], 0.001)) for k, v in sorted(provinces.items())])
dump('cities.json', [dict(key=c['key'], psgc=c['psgc'], name=c['name'], provincePsgc=c['province'], regionPsgc=c['region'],
                          derivedBoundary=c['derived'], islandId=c['island'], lat=r6(c['pt'].y), lon=r6(c['pt'].x),
                          geometry=geom_json(c['geom'])) for c in cities])

# ---------------------------------------------------------------- T2MIS (xlsx)
print('t2mis', file=sys.stderr)
wb = openpyxl.load_workbook(os.path.join(RAW, 'GROUP_C_DATASET.xlsx'), read_only=True, data_only=True)


def sheet(name):
    rows = [r for r in wb[name].iter_rows(values_only=True)]
    head = [str(h).strip() if h is not None else f'col{i}' for i, h in enumerate(rows[0])]
    return [dict(zip(head, r)) for r in rows[1:] if any(v not in (None, '') for v in r)]


def clean(v):
    return None if v in (None, 'NULL', '') else v


# Qualifications come from the TESDA API (npm run tesda:sync), by name; the T2MIS Qualifications sheet is not used.

xl_centers = {num(r['CenterId']): r for r in sheet('T2MIS Assessment Centers') if num(r['CenterId']) is not None}
gj = json.load(open(os.path.join(RAW, 'assessment_center_points.geojson')))['features']
USABLE = {'validated', 'geocoded_fill', 'geocode_override', 'water_fixed_geocode'}
centers = []
for f in gj:
    p = f['properties']
    lon, lat = f['geometry']['coordinates']
    pt = Point(lon, lat)
    ph = 4.4 < lat < 21.5 and 116.5 < lon < 127.0
    city = city_of(pt) if ph else None
    xl = xl_centers.get(int(p['CenterId']), {})
    closed = str(xl.get('School_Close')) in ('1', '1.0', 'True')
    hidden = p['RegionName'] in ('Hidden', 'CO')
    usable = p['coord_status'] in USABLE and not p['is_foreign'] and ph and city is not None and not hidden and not closed
    centers.append(dict(
        id=int(p['CenterId']), name=str(p['Assessment_Center']).strip(), address=clean(p['Address']), phone=clean(p['Phone']),
        email=clean(xl.get('e_mail')), district=clean(p['District']), sourceRegionName=p['RegionName'],
        sourceProvinceName=p['ProvinceName'], sourceCityName=p['CityName'], lat=r6(lat), lon=r6(lon),
        coordStatus=p['coord_status'], coordSource=p['coord_source'], isForeign=bool(p['is_foreign']),
        isClosed=closed, isHidden=hidden, includeInAnalysis=usable,
        cityKey=city['key'] if city else None, provincePsgc=city['province'] if city else None, regionPsgc=city['region'] if city else None,
        islandId=island_of(pt) if ph else None,
        createdAt=epoch(xl.get('DateCreated')),
    ))
# The centers themselves come from the TESDA API (npm run tesda:sync). Only Team C's hand-corrected positions are seeded:
# the sync keeps them over the API's raw point.
CORRECTED = {'geocode_override', 'water_fixed_geocode'}
corrections = [c for c in centers if c['coordStatus'] in CORRECTED]
dump('center_corrections.json', corrections)
print(f"  corrected center positions: {len(corrections)} of {len(centers)} centers", file=sys.stderr)

# ---------------------------------------------------------------- BSRS
print('bsrs', file=sys.stderr)
REG_ALIAS = {
    'regioni': '0100000000', 'regionii': '0200000000', 'regioniii': '0300000000', 'regioniva': '0400000000', 'regionv': '0500000000',
    'regionvi': '0600000000', 'regionvii': '0700000000', 'regionviii': '0800000000', 'regionix': '0900000000', 'regionx': '1000000000',
    'regionxi': '1100000000', 'regionxii': '1200000000', 'nationalcapitalregion': '1300000000', 'cordilleraadministrativeregion': '1400000000',
    'regionxiii': '1600000000', 'regionivb': '1700000000', 'bangsamoro': '1900000000', 'autonomousregioninmuslimmindanao': '1900000000',
}


def region_code(name):
    n = norm(name)
    if n.startswith('bangsamoro'):
        return '1900000000'
    if n.startswith('autonomousregion'):
        return '1900000000'
    for k in sorted(REG_ALIAS, key=len, reverse=True):
        if n.startswith(k):
            return REG_ALIAS[k]
    return None


PROV_ALIAS = {'compostelavalley': 'davaodeoro', 'northcotabato': 'cotabato', 'maguindanao': 'maguindanaodelnorte'}
prov_by = collections.defaultdict(list)
for k, v in provinces.items():
    prov_by[norm(v['name'])].append(k)
NCR_DISTRICTS = {'camanava': ['caloocan', 'malabon', 'navotas', 'valenzuela'],
                 'muntiparlastapat': ['muntinlupa', 'paranaque', 'laspinas', 'taguig', 'pateros'],
                 'pamamarisan': ['pasig', 'marikina', 'mandaluyong', 'sanjuan'], 'pasmak': ['pasay', 'makati'],
                 'quezon': ['quezon'], 'manila': ['manila']}

stats = []
for r in sheet('BSRS Scholarship Data Per Regio'):
    if r.get('enrolled_count') is None:
        continue
    stats.append(dict(level='REGION', sourceName=r['region'], regionPsgc=region_code(r['region']), provincePsgc=None, cityKey=None,
                      cityKeys=None, enrolled=int(r['enrolled_count']), completed=int(r['completed_count']),
                      completionRate=float(r['completion_rate_pct'])))
for r in sheet('BSRS Scholarship Data Per Provi'):
    if r.get('enrolled_count') is None:
        continue
    rc = region_code(r['region'])
    pc, keys = None, None
    if rc == '1300000000':
        want = NCR_DISTRICTS.get(norm(r['province']), [])
        keys = [c['key'] for c in cities if c['region'] == rc and any(norm(c['name']).startswith(w) for w in want)]
    else:
        cand = prov_by.get(PROV_ALIAS.get(norm(r['province']), norm(r['province'])), [])
        pc = cand[0] if cand else None
    stats.append(dict(level='PROVINCE', sourceName=r['province'], regionPsgc=rc, provincePsgc=pc, cityKey=None, cityKeys=keys,
                      enrolled=int(r['enrolled_count']), completed=int(r['completed_count']), completionRate=float(r['completion_rate_pct'])))
city_by = collections.defaultdict(list)
for c in cities:
    city_by[(c['province'], norm(c['name']))].append(c)
    city_by[('*', norm(c['name']))].append(c)
for r in sheet('BSRS Scholarship Data Per Citii'):
    if r.get('enrolled_count') is None or not r.get('city_mun'):
        continue
    rc = region_code(r['region'])
    # NCR has no provinces to match by name; matching "Quezon City" as a province would hit Quezon province
    # (norm() drops "city"), so NCR rows only match cities by name inside NCR.
    pcs = [] if rc == '1300000000' else prov_by.get(PROV_ALIAS.get(norm(r['province']), norm(r['province'])), [])
    hit = None
    if ', city of manila' in str(r['city_mun']).lower():   # Manila districts (Binondo, Ermita, ...) -> City of Manila
        r = dict(r, city_mun='City of Manila')
    for pc in pcs:
        if city_by.get((pc, norm(r['city_mun']))):
            hit = city_by[(pc, norm(r['city_mun']))][0]
    if hit is None:
        m = [c for c in city_by.get(('*', norm(r['city_mun'])), []) if c['region'] == rc]
        hit = m[0] if len(m) == 1 else None
    stats.append(dict(level='CITY', sourceName=r['city_mun'], regionPsgc=rc, provincePsgc=hit['province'] if hit else (pcs[0] if pcs else None),
                      cityKey=hit['key'] if hit else None, cityKeys=None, enrolled=int(r['enrolled_count']),
                      completed=int(r['completed_count']), completionRate=float(r['completion_rate_pct'])))
dump('bsrs_stats.json', stats)
unm = [s['sourceName'] for s in stats if s['level'] == 'PROVINCE' and not s['provincePsgc'] and not s['cityKeys']]
unc = [s['sourceName'] for s in stats if s['level'] == 'CITY' and not s['cityKey']]
print(f'  unmatched provinces {unm}; unmatched cities {len(unc)}: {unc[:8]}', file=sys.stderr)
print('done', file=sys.stderr)
