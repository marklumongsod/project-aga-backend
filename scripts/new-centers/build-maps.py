#!/usr/bin/env python3
"""
Build the backend <-> raw T2MIS mappings for the New Center Model.

    python3 scripts/new-centers/build-maps.py --data-dir /path/to/Data

Outputs:
  docs/new-centers/province_map.csv
  docs/new-centers/qualification_map.csv

The raw data is only read; the outputs contain province/qualification names and IDs, no learner data.
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
NS = {
    'm': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
}
ROMAN = {1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V'}


def psql(sql):
    out = subprocess.check_output(
        ['docker', 'compose', 'exec', '-T', 'db', 'psql', '-U', 'aga', '-d', 'aga', '-AtF', '\t', '-c', sql],
        cwd=ROOT,
        text=True,
    )
    return [line.split('\t') for line in out.splitlines() if line.strip()]


def norm(value):
    value = unicodedata.normalize('NFKD', value or '').encode('ascii', 'ignore').decode()
    value = value.replace('_x000D_', '').replace('NC', ' ')
    return re.sub(r'[^a-z0-9]', '', value.lower())


def qualification_key(value):
    """Same normalization as src/simulation/qualification-need.ts."""
    value = (value or '').lower()
    value = re.sub(r'\bnc\b', ' ', value)
    value = re.sub(r'[^a-z0-9]+', ' ', value)
    return value.strip()


def read_xlsx(path, wanted):
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
                    value = ''.join(t.text or '' for t in cell.iter('{%s}t' % NS['m']))
                values.append(value)
            rows.append(values)
        return rows


def table(rows):
    if not rows:
        return []
    header = [h.strip() for h in rows[0]]
    return [dict(zip(header, row + [''] * (len(header) - len(row)))) for row in rows[1:]]


def raw_number(value):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data-dir', required=True, help='folder with Qualification.xlsx and Center.csv')
    ap.add_argument('--out-dir', default=os.path.join(ROOT, 'docs', 'new-centers'))
    args = ap.parse_args()

    xlsx = os.path.join(args.data_dir, 'Qualification.xlsx')
    raw_provinces = table(read_xlsx(xlsx, 'Province'))
    raw_quals = table(read_xlsx(xlsx, 'Qualification'))
    raw_center_quals = table(read_xlsx(xlsx, 'CenterQual'))
    raw_centers = []
    with open(os.path.join(args.data_dir, 'Center.csv'), newline='', encoding='utf-8-sig', errors='replace') as fh:
        raw_centers = list(csv.DictReader(fh))

    backend_provinces = {
        row[0]: {'name': row[1], 'region': row[2]}
        for row in psql('SELECT psgc, name, region_psgc FROM provinces ORDER BY psgc')
    }
    backend_qualifications = {
        row[0]: row[1]
        for row in psql('SELECT DISTINCT qualification, qualification FROM center_qualifications ORDER BY qualification')
    }
    backend_center_quals = defaultdict(list)
    for center_id, qualification in psql('SELECT center_id, qualification FROM center_qualifications ORDER BY center_id, qualification'):
        backend_center_quals[int(center_id)].append(qualification)

    # ------------------------------------------------------------------ provinces
    # raw ProvinceId -> backend PSGC. The old ARMM/new BARMM and NCR duplicates are explicit:
    # a new center belongs to the current backend province, so use the current raw ID.
    raw_by_name = defaultdict(list)
    raw_by_id = {}
    for row in raw_provinces:
        pid = raw_number(row.get('ProvinceId'))
        name = (row.get('ProvinceName') or '').replace('_x000D_', '').strip()
        if pid is not None:
            raw_by_name[norm(name)].append((pid, name))
            raw_by_id[pid] = name

    province_override = {
        '1900700000': (84, 'Basilan (current BARMM)'),
        '1903600000': (89, 'Lanao del Sur (current BARMM)'),
        '1906600000': (90, 'Sulu (current BARMM)'),
        '1907000000': (91, 'Tawi-Tawi (current BARMM)'),
        '1908700000': (92, 'Maguindanao del Norte'),
        '1908800000': (93, 'Maguindanao del Sur'),
        '1909900000': (93, 'Special Geographic Area; nearest raw province is Maguindanao del Sur'),
        '0990100000': (97, 'City of Isabela'),
        '1303900000': (39, 'City of Manila'),
        '1307400000': (88, 'NCR Second District: raw Quezon City has the most centers'),
        '1307500000': (74, 'NCR Third District: CAMANAVA'),
        '1307600000': (76, 'NCR Fourth District: MUNTIPARLASTAPAT has the most centers'),
    }
    province_name_alias = {
        '0806000000': 'Samar (Western Samar)',
        '1108200000': 'Compostela Valley',
        '1204700000': 'North Cotabato',
    }
    province_rows = []
    unmatched = []
    for psgc, info in backend_provinces.items():
        if psgc in province_override:
            raw_id, note = province_override[psgc]
            raw_name = raw_by_id.get(raw_id, '')
        else:
            candidates = raw_by_name.get(norm(province_name_alias.get(psgc, info['name'])), [])
            if not candidates:
                unmatched.append((psgc, info['name']))
                continue
            # Prefer a non-historical raw ID if multiple names exist.
            raw_id, raw_name = candidates[0]
            note = '' if len(candidates) == 1 else 'multiple raw matches; first used'
        province_rows.append({
            'province_psgc': psgc,
            'province_name': info['name'],
            'raw_province_id': raw_id,
            'raw_province_name': raw_name,
            'note': note,
        })
    province_rows.sort(key=lambda r: r['province_psgc'])
    os.makedirs(args.out_dir, exist_ok=True)
    with open(os.path.join(args.out_dir, 'province_map.csv'), 'w', newline='', encoding='utf-8') as fh:
        writer = csv.DictWriter(fh, fieldnames=['province_psgc', 'province_name', 'raw_province_id', 'raw_province_name', 'note'], lineterminator='\n')
        writer.writeheader()
        writer.writerows(province_rows)
    print('province_map.csv:', len(province_rows), 'rows; unmatched:', len(unmatched))
    for psgc, name in unmatched:
        print('  UNMATCHED PROVINCE', psgc, name)

    # ------------------------------------------------------------------ qualifications
    qual_by_id = {}
    qual_by_display = defaultdict(list)
    for row in raw_quals:
        qid = raw_number(row.get('QualId'))
        if qid is None:
            continue
        title = (row.get('QualificationTitle') or '').strip()
        level = raw_number(row.get('LevelId'))
        display = f'{title} {ROMAN.get(level, "")}'.strip()
        qual_by_id[qid] = {'title': title, 'level': level, 'display': display}
        qual_by_display[qualification_key(display)].append(qid)
        qual_by_display[qualification_key(title)].append(qid)

    # Per-center raw QualIds, to pair a backend name with the raw ID that center actually uses.
    center_raw = defaultdict(set)
    for row in raw_center_quals:
        cid, qid = raw_number(row.get('CenterId')), raw_number(row.get('QualId'))
        if cid is not None and qid is not None:
            center_raw[cid].add(qid)

    votes = defaultdict(Counter)
    for center_id, names in backend_center_quals.items():
        raw_ids = center_raw.get(center_id, set())
        for name in names:
            key = qualification_key(name)
            for qid in raw_ids:
                raw = qual_by_id.get(qid)
                if raw and qualification_key(raw['display']) == key:
                    votes[name][qid] += 1
                    break
    # One row per raw qualification display. This is the full catalog the model can score, not only the
    # qualifications currently present in the backend center list.
    by_key = defaultdict(list)
    for qid, raw in qual_by_id.items():
        by_key[qualification_key(raw['display'])].append(qid)
    backend_by_key = defaultdict(list)
    for name in backend_qualifications:
        backend_by_key[qualification_key(name)].append(name)
    qualification_rows = []
    missing = []
    for key, ids in by_key.items():
        backend_name = (backend_by_key.get(key) or [None])[0]
        if backend_name and votes[backend_name]:
            qid = votes[backend_name].most_common(1)[0][0]
            note = '' if len(votes[backend_name]) == 1 else 'chosen by most centers'
        else:
            qid = sorted(ids)[0]
            note = 'raw qualification'
        raw = qual_by_id[qid]
        qualification_rows.append({
            'qualification_key': key,
            'qualification': raw['display'],
            'raw_qual_id': qid,
            'raw_title': raw['title'],
            'raw_level': raw['level'] if raw['level'] is not None else '',
            'note': note,
        })
    for name in sorted(backend_qualifications):
        if qualification_key(name) not in by_key:
            missing.append(name)
    qualification_rows.sort(key=lambda r: r['qualification'].lower())
    with open(os.path.join(args.out_dir, 'qualification_map.csv'), 'w', newline='', encoding='utf-8') as fh:
        writer = csv.DictWriter(fh, fieldnames=['qualification_key', 'qualification', 'raw_qual_id', 'raw_title', 'raw_level', 'note'], lineterminator='\n')
        writer.writeheader()
        writer.writerows(qualification_rows)
    print('qualification_map.csv:', len(qualification_rows), 'rows; unmatched backend names:', len(missing))
    for name in missing[:30]:
        print('  UNMATCHED QUALIFICATION', name)


if __name__ == '__main__':
    main()
