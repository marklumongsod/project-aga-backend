#!/usr/bin/env python3
"""
Build docs/forecast/forecast_places.csv: the raw T2MIS place ID -> backend PSGC / center mapping.

Run this once (or after a geography change) from the repository root:

    python3 scripts/forecast/build-place-map.py

Inputs:
  Forecast_Model/Data/Qualification.xlsx  Region and Province sheets (names + raw IDs)
  Forecast_Model/Data/Center.csv           CenterId, RegionId, ProvinceId, Assessment_Center
  Postgres                                 regions, provinces, assessment_centers

Output:
  docs/forecast/forecast_places.csv

Columns:
  level, source_place_id, parent_source_id, name, target_type, target_code, share, note

target_type:
  national  -> target_code PH
  region    -> target_code is a region PSGC
  province  -> target_code is a province PSGC
  center    -> target_code is assessment_centers.id
  excluded  -> not shown in the Philippine forecast view

A source place may have more than one row only when its forecast is split between two
backend areas (currently only the old Maguindanao province). The shares must sum to 1.
"""
import argparse
import csv
import os
import re
import subprocess
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
XLSX = os.path.join(ROOT, 'Forecast_Model', 'Data', 'Qualification.xlsx')
CENTER_CSV = os.path.join(ROOT, 'Forecast_Model', 'Data', 'Center.csv')
OUT = os.path.join(ROOT, 'docs', 'forecast', 'forecast_places.csv')
NS = {
    'm': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
}


def psql(sql):
    out = subprocess.check_output(
        ['docker', 'compose', 'exec', '-T', 'db', 'psql', '-U', 'aga', '-d', 'aga', '-AtF', '\t', '-c', sql],
        cwd=ROOT,
        text=True,
    )
    return [line.split('\t') for line in out.splitlines() if line.strip()]


def read_xlsx_sheet(path, wanted):
    """Read one worksheet as a list of rows. Only standard-library modules are used."""
    with zipfile.ZipFile(path) as z:
        shared = []
        if 'xl/sharedStrings.xml' in z.namelist():
            root = ET.fromstring(z.read('xl/sharedStrings.xml'))
            for si in root.findall('m:si', NS):
                shared.append(''.join(t.text or '' for t in si.iter('{%s}t' % NS['m'])))
        workbook = ET.fromstring(z.read('xl/workbook.xml'))
        rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
        relmap = {r.get('Id'): r.get('Target') for r in rels}
        sheets = {
            s.get('name'): relmap[s.get('{%s}id' % NS['r'])]
            for s in workbook.find('m:sheets', NS)
        }
        target = sheets[wanted]
        if not target.startswith('xl/'):
            target = 'xl/' + target.lstrip('/')
        root = ET.fromstring(z.read(target))
        rows = []
        for row in root.findall('.//m:sheetData/m:row', NS):
            values = []
            for cell in row.findall('m:c', NS):
                v = cell.find('m:v', NS)
                value = '' if v is None else (v.text or '')
                if cell.get('t') == 's' and value != '':
                    value = shared[int(value)]
                elif cell.get('t') == 'inlineStr':
                    value = ''.join(
                        t.text or '' for t in cell.iter('{%s}t' % NS['m'])
                    )
                values.append(value)
            rows.append(values)
        return rows


def norm(value):
    value = unicodedata.normalize('NFKD', value or '').encode('ascii', 'ignore').decode()
    value = value.replace('_x000D_', '')
    return re.sub(r'[^a-z0-9]', '', value.lower())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        '--forecast',
        default=os.path.join(ROOT, 'forecast_out', 'forecasts_2026-10.json'),
        help='optional forecast JSON used to check that every output place is covered',
    )
    args = parser.parse_args()

    regions = {row[0]: row[1] for row in psql('SELECT psgc, name FROM regions ORDER BY psgc')}
    provinces = {
        row[0]: {'name': row[1], 'region': row[2]}
        for row in psql('SELECT psgc, name, region_psgc FROM provinces ORDER BY psgc')
    }
    centers = {
        int(row[0]): {
            'region': row[1],
            'province': row[2],
            'include': row[3] == 't',
            'foreign': row[4] == 't',
            'closed': row[5] == 't',
            'hidden': row[6] == 't',
        }
        for row in psql(
            'SELECT id, region_psgc, province_psgc, include_in_analysis, is_foreign, is_closed, is_hidden '
            'FROM assessment_centers ORDER BY id'
        )
    }

    region_rows = read_xlsx_sheet(XLSX, 'Region')
    province_rows = read_xlsx_sheet(XLSX, 'Province')
    raw_regions = {row[0]: row[1].strip() for row in region_rows[1:] if len(row) >= 2}
    raw_provinces = {
        row[0]: {'region': row[1], 'name': row[2].replace('_x000D_', '').strip()}
        for row in province_rows[1:]
        if len(row) >= 3
    }

    region_name = {norm(v): k for k, v in regions.items()}
    province_name = {norm(v['name']): k for k, v in provinces.items()}

    # Regions 1-17, 19 -> the matching PSGC. 15 (ARMM) and 19 (BARMM) share BARMM.
    # 18 (NIR), 20 (CO/overseas), 21 (Other Country) are not part of the backend geography.
    region_target = {
        '1': '0100000000', '2': '0200000000', '3': '0300000000', '4': '0400000000',
        '5': '0500000000', '6': '0600000000', '7': '0700000000', '8': '0800000000',
        '9': '0900000000', '10': '1000000000', '11': '1100000000', '12': '1200000000',
        '13': '1300000000', '14': '1400000000', '15': '1900000000', '16': '1600000000',
        '17': '1700000000', '19': '1900000000',
    }
    region_note = {
        '15': 'old ARMM; summed into BARMM',
        '19': 'BARMM',
        '18': 'Negros Island Region: backend keeps these provinces under Region VI/VII',
        '20': 'CO / overseas posts; excluded from Philippine area forecasts',
        '21': 'Other Country; excluded',
    }

    # Direct overrides first. These are the historical duplicates and the TESDA NCR districts.
    province_target = {
        '7': ('1900700000', 'old ARMM Basilan; summed with 84'),
        '84': ('1900700000', 'BARMM Basilan; summed with 7'),
        '36': ('1903600000', 'old ARMM Lanao del Sur; summed with 89'),
        '89': ('1903600000', 'BARMM Lanao del Sur; summed with 36'),
        '66': ('1906600000', 'old ARMM Sulu; summed with 90'),
        '90': ('1906600000', 'BARMM Sulu; summed with 66'),
        '70': ('1907000000', 'old ARMM Tawi-Tawi; summed with 91'),
        '91': ('1907000000', 'BARMM Tawi-Tawi; summed with 70'),
        '92': ('1908700000', 'Maguindanao del Norte'),
        '93': ('1908800000', 'Maguindanao del Sur'),
        '39': ('1303900000', 'TESDA City of Manila -> NCR First District'),
        '74': ('1307500000', 'TESDA CAMANAVA -> NCR Third District'),
        '75': ('1307600000', 'TESDA PASMAK -> NCR Fourth District'),
        '76': ('1307600000', 'TESDA MUNTIPARLASTAPAT -> NCR Fourth District'),
        '87': ('1307400000', 'TESDA PAMAMARISAN -> NCR Second District'),
        '88': ('1307400000', 'TESDA Quezon City -> NCR Second District'),
        '82': ('1108200000', 'Compostela Valley -> Davao de Oro'),
        '47': ('1204700000', 'North Cotabato -> Cotabato'),
        '60': ('0806000000', 'Samar (Western Samar) -> Samar'),
        '97': ('0907300000', 'sheet says City of Isabela; 32 of 34 centers are in Zamboanga City'),
    }

    # The old Maguindanao province has no assessments after April 2025. Its forecast is
    # split by all-time candidate share: del Norte 12,731 and del Sur 4,123.
    maguindanao_split = [('1908700000', 0.7554), ('1908800000', 0.2446)]

    rows = []
    rows.append({
        'level': 'national', 'source_place_id': 'PH', 'parent_source_id': '',
        'name': 'Philippines', 'target_type': 'national', 'target_code': 'PH',
        'share': '1', 'note': '',
    })

    for raw_id, name in sorted(raw_regions.items(), key=lambda x: int(x[0])):
        target = region_target.get(raw_id)
        if target:
            rows.append({
                'level': 'region', 'source_place_id': raw_id, 'parent_source_id': 'PH',
                'name': name, 'target_type': 'region', 'target_code': target,
                'share': '1', 'note': region_note.get(raw_id, ''),
            })
        else:
            rows.append({
                'level': 'region', 'source_place_id': raw_id, 'parent_source_id': 'PH',
                'name': name, 'target_type': 'excluded', 'target_code': '-',
                'share': '0', 'note': region_note.get(raw_id, 'excluded'),
            })

    for raw_id, info in sorted(raw_provinces.items(), key=lambda x: int(x[0])):
        raw_region = info['region']
        name = info['name']
        note = ''
        if raw_id == '38':
            for target, share in maguindanao_split:
                rows.append({
                    'level': 'province', 'source_place_id': raw_id,
                    'parent_source_id': raw_region, 'name': name,
                    'target_type': 'province', 'target_code': target,
                    'share': str(share), 'note': 'old Maguindanao split between del Norte/del Sur',
                })
            continue
        if raw_id in province_target:
            target, note = province_target[raw_id]
        elif raw_region in ('18', '20', '21') or raw_id in ('94', '95', '96', '98', '99', '389', '393', '394'):
            rows.append({
                'level': 'province', 'source_place_id': raw_id,
                'parent_source_id': raw_region, 'name': name,
                'target_type': 'excluded', 'target_code': '-',
                'share': '0', 'note': 'not in the backend Philippine geography',
            })
            continue
        else:
            target = province_name.get(norm(name))
        if target:
            rows.append({
                'level': 'province', 'source_place_id': raw_id,
                'parent_source_id': raw_region, 'name': name,
                'target_type': 'province', 'target_code': target,
                'share': '1', 'note': note,
            })
        else:
            rows.append({
                'level': 'province', 'source_place_id': raw_id,
                'parent_source_id': raw_region, 'name': name,
                'target_type': 'excluded', 'target_code': '-',
                'share': '0', 'note': 'no backend province match',
            })

    with open(CENTER_CSV, newline='', encoding='utf-8-sig', errors='replace') as fh:
        raw_centers = {}
        for row in csv.DictReader(fh):
            try:
                center_id = int(row['CenterId'])
            except (TypeError, ValueError):
                continue
            raw_centers[center_id] = {
                'region': row['RegionId'],
                'province': row['ProvinceId'],
                'name': row['Assessment_Center'],
            }

    for center_id, info in sorted(raw_centers.items()):
        backend = centers.get(center_id)
        if not backend:
            note = 'not in assessment_centers yet'
        elif backend['foreign']:
            note = 'foreign center'
        elif backend['closed']:
            note = 'closed center'
        elif backend['hidden']:
            note = 'hidden center'
        else:
            note = ''
        rows.append({
            'level': 'center', 'source_place_id': str(center_id),
            'parent_source_id': info['province'], 'name': info['name'],
            'target_type': 'excluded' if note else 'center',
            'target_code': '-' if note else str(center_id),
            'share': '0' if note else '1', 'note': note,
        })

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', newline='', encoding='utf-8') as fh:
        writer = csv.DictWriter(
            fh,
            fieldnames=['level', 'source_place_id', 'parent_source_id', 'name',
                        'target_type', 'target_code', 'share', 'note'],
            lineterminator='\n',
        )
        writer.writeheader()
        writer.writerows(rows)

    # Report and validate.
    counts = Counter((r['level'], r['target_type']) for r in rows)
    print('wrote', OUT)
    print('rows', len(rows))
    for key in sorted(counts):
        print('  %-8s %-9s %5d' % (key[0], key[1], counts[key]))

    by_source = defaultdict(list)
    for row in rows:
        by_source[(row['level'], row['source_place_id'])].append(row)
    multi = {k: v for k, v in by_source.items() if len(v) > 1}
    bad_shares = {
        k: sum(float(r['share']) for r in v)
        for k, v in multi.items()
        if abs(sum(float(r['share']) for r in v) - 1) > 1e-6
    }
    print('multi-target places', len(multi), 'bad share sums', len(bad_shares))
    for key, total in list(bad_shares.items())[:10]:
        print('  BAD', key, total)

    # Every place in the current forecast output must have a mapping row.
    forecast_path = args.forecast
    if os.path.exists(forecast_path):
        import json
        with open(forecast_path, encoding='utf-8') as fh:
            forecast_rows = json.load(fh)
        places = {(r['level'], r['place_id']) for r in forecast_rows}
        missing = sorted(p for p in places if p not in by_source)
        print('forecast places', len(places), 'missing mapping', len(missing))
        for level, place in missing[:20]:
            print('  MISSING', level, place)
        unmapped_p = [
            (r['level'], r['place_id'])
            for r in forecast_rows
            if r['level'] in ('region', 'province')
            and all(x['target_type'] == 'excluded' for x in by_source.get((r['level'], r['place_id']), []))
        ]
        print('forecast region/province places excluded by policy', len(set(unmapped_p)))


if __name__ == '__main__':
    main()
