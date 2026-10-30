"""
Graduates per province and qualification, for the "which qualifications should a new center offer" recommendation.

    python3 -I etl/build_qualification_demand.py [path/to/Graduates.xlsx]

Reads the team's graduate list (one sheet, "Graduate with assessment": a COUNT per sex, province, qualification and year,
so there are no names, ULIs or other learner details) and writes database/seed-data/province_qualifications.json.
Counts are summed over all years in the file. Load it with `npm run data:qualifications` (also part of `npm run db:seed`).

Province names in the sheet are matched to PSGC provinces. The sheet predates some changes, so a few are mapped by hand:
  Compostela Valley -> Davao de Oro      North Cotabato -> Cotabato
  Maguindanao       -> Maguindanao del Norte AND del Sur (the same counts for both)
  NCR districts     -> pooled, and the same mix is given to all four NCR "districts"
Qualification ids are T2MIS QualIds, the same ids as the `qualifications` table.
"""
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data" / "raw" / "Graduates.xlsx"
OUT = ROOT / "database" / "seed-data" / "province_qualifications.json"

provinces = json.loads((ROOT / "database" / "seed-data" / "provinces.json").read_text())


def norm(s: str) -> str:
    s = re.sub(r"\(.*?\)", "", s.lower())
    s = s.replace("city of", "").replace("province", "")
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


by_name = {norm(p["name"]): p["psgc"] for p in provinces}
ncr = [p["psgc"] for p in provinces if p["psgc"].startswith("13")]
BY_HAND = {
    "compostela valley": ["1108200000"],
    "north cotabato": ["1204700000"],
    "maguindanao": ["1908700000", "1908800000"],
}

wb = openpyxl.load_workbook(SRC, read_only=True, data_only=True)
ws = wb.worksheets[0]
rows = ws.iter_rows(min_row=1, values_only=True)
head = [str(h) for h in next(rows)]
col = {h: i for i, h in enumerate(head)}
for need in ("Graduate", "Qualification", "RegionName", "ProvinceName", "QualId"):
    if need not in col:
        sys.exit(f"{SRC}: no '{need}' column (found {head})")

totals: dict = defaultdict(int)  # (psgc, qualId, title) -> graduates
ncr_pool: dict = defaultdict(int)
unmatched: dict = defaultdict(int)
for r in rows:
    n = r[col["Graduate"]]
    if not isinstance(n, (int, float)) or n <= 0:
        continue
    region, prov = str(r[col["RegionName"]] or ""), str(r[col["ProvinceName"]] or "")
    qid, title = r[col["QualId"]], re.sub(r"\s+", " ", str(r[col["Qualification"]] or "")).strip()
    if qid is None or not title:
        continue
    key = (int(qid), title)
    if "National Capital" in region or "NCR" in region:
        ncr_pool[key] += int(n)
        continue
    targets = BY_HAND.get(norm(prov)) or ([by_name[norm(prov)]] if norm(prov) in by_name else [])
    if not targets:
        unmatched[(region, prov)] += int(n)
        continue
    for psgc in targets:
        totals[(psgc, *key)] += int(n)
for psgc in ncr:
    for key, n in ncr_pool.items():
        totals[(psgc, *key)] += n

out = [
    {"provincePsgc": psgc, "qualificationId": qid, "qualification": title, "graduates": n}
    for (psgc, qid, title), n in sorted(totals.items())
]
OUT.write_text(json.dumps(out, separators=(",", ":")))
print(f"wrote {OUT.relative_to(ROOT)}: {len(out)} rows, {len({o['provincePsgc'] for o in out})} provinces, "
      f"{len({o['qualificationId'] for o in out})} qualifications, {sum(o['graduates'] for o in out):,} graduates")
if unmatched:
    print("NOT matched to a province (left out):", dict(unmatched))
