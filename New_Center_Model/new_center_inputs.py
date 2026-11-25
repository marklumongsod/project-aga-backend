"""
Build the model inputs for a new or planned assessment center from the raw TESDA data.

Same rules as the New Center Panel notebook: every input is measured in the month before the accreditation month,
using only data known at that time.

    from new_center_inputs import InputBuilder
    b = InputBuilder("/path/to/Data", last_month="2026-08")
    rows = b.rows({"province_id": 45, "city_id": 1203, "qual_ids": [101, 205], "accreditation_month": "2026-09"})

`rows` has 12 rows (months 1-12 after accreditation) with the columns the models need.
"""
import os
import re
import warnings

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")
START = pd.Period("2022-01", "M")
G0 = 6                     # 2022-07: first reliable month
MONTHS_AFTER = 12


def _mi(d):
    return (d.dt.year - START.year) * 12 + d.dt.month - START.month


def _num(v):
    """Number or NaN (accepts None, NaN and pandas NA)."""
    return np.nan if v is None or pd.isna(v) else float(v)


class InputBuilder:
    def __init__(self, data_dir, last_month):
        self.data_dir = data_dir
        self.xlsx = os.path.join(data_dir, "Qualification.xlsx")
        self.LAST = (pd.Period(last_month, "M") - START).n
        self._load()

    # ------------------------------------------------------------------ loading
    def _csv(self, name, cols, dates=()):
        df = pd.read_csv(os.path.join(self.data_dir, name + ".csv"), usecols=cols, dtype=str,
                         na_values=["NULL", ""], keep_default_na=False)
        for c in cols:
            if c in dates:
                df[c] = pd.to_datetime(df[c], format="ISO8601", errors="coerce")
            elif c.endswith("Id"):
                df[c] = pd.to_numeric(df[c], errors="coerce")
        return df.drop_duplicates().dropna(subset=[cols[0]])

    def _sheet(self, sheet, cols):
        df = pd.read_excel(self.xlsx, sheet_name=sheet, usecols=cols, dtype=str)
        df.columns = [c.strip() for c in df.columns]
        return df

    def _load(self):
        a = (self._csv("Assessment", ["AssessmentId", "CenterSchedId", "ULIId"]).dropna()
             .merge(self._csv("CenterSched", ["CenterSchedId", "CenterProgramId", "DateStarted"], ["DateStarted"]).dropna(), on="CenterSchedId")
             .merge(self._csv("CenterProgram", ["CenterProgramId", "CenterId", "QualId"]).dropna(), on="CenterProgramId"))
        a["m"] = _mi(a["DateStarted"])
        a = a[a["m"].between(0, self.LAST)]

        e = (self._csv("Enroll", ["EnrollId", "SchSchedId"]).dropna()
             .merge(self._csv("SchSched", ["SchSchedId", "SchProgramId", "DateStarted", "DateFinished"], ["DateStarted", "DateFinished"]).dropna(), on="SchSchedId")
             .merge(self._csv("Schprogram", ["SchProgramId", "SchId", "QualId"]).dropna(), on="SchProgramId")
             .merge(self._csv("School", ["SchId", "ProvinceId", "CityId"]), on="SchId"))
        e = e[e["DateFinished"] >= e["DateStarted"]].copy()
        e["s"], e["f"] = _mi(e["DateStarted"]), _mi(e["DateFinished"])

        qual = self._sheet("Qualification", ["QualId", "SectorId", "LevelId", "Duration"]).apply(pd.to_numeric, errors="coerce")
        qual["Duration"] = qual["Duration"].abs()
        self.qual = qual.dropna(subset=["QualId"]).drop_duplicates("QualId").set_index("QualId")

        wc = self._sheet("Center", ["CenterId", "RegionId", "ProvinceId", "CityId", "Assessment_Center"])
        for c in ["CenterId", "RegionId", "ProvinceId", "CityId"]:
            wc[c] = pd.to_numeric(wc[c], errors="coerce")
        wc = wc.dropna(subset=["CenterId"]).drop_duplicates("CenterId").set_index("CenterId")
        cc = self._csv("Center", ["CenterId", "RegionId", "ProvinceId", "CityId", "Assessment_Center"]).drop_duplicates("CenterId").set_index("CenterId")
        centers = wc.combine_first(cc)
        self.region_of_province = centers.dropna(subset=["ProvinceId", "RegionId"]).groupby("ProvinceId")["RegionId"].agg(lambda s: s.mode().iloc[0])

        def to_dict(df, keys, cols):
            return {k: g[cols].to_numpy(dtype="float64") for k, g in df.groupby(keys)}
        self.SUP_P = to_dict(e.groupby(["ProvinceId", "QualId", "s", "f"]).size().rename("n").reset_index(), ["ProvinceId", "QualId"], ["s", "f", "n"])
        self.SUP_C = to_dict(e.dropna(subset=["CityId"]).groupby(["CityId", "QualId", "s", "f"]).size().rename("n").reset_index(), ["CityId", "QualId"], ["s", "f", "n"])
        self.SUP_S = to_dict(e.groupby(["SchId", "QualId", "s", "f"]).size().rename("n").reset_index(), ["SchId", "QualId"], ["s", "f", "n"])

        a["ProvinceId"] = a["CenterId"].map(centers["ProvinceId"])
        c_pq = (a.dropna(subset=["ProvinceId"]).drop_duplicates(["ULIId", "CenterId", "QualId", "m"])
                .groupby(["ProvinceId", "QualId", "CenterId", "m"]).size().rename("n").reset_index())
        self.COMP = to_dict(c_pq, ["ProvinceId", "QualId"], ["CenterId", "m", "n"])
        ca = a.dropna(subset=["ProvinceId"]).drop_duplicates(["ULIId", "CenterId", "m"])
        self.PROV_CAND = ca.groupby(["ProvinceId", "m"]).size()
        self.PROV_ACTIVE = ca.groupby(["ProvinceId", "m"])["CenterId"].nunique()

        schools = self._csv("School", ["SchId", "ProvinceId", "Provider_Name"])
        self.schools = schools.assign(name=self.norm(schools["Provider_Name"]))

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def norm(s):
        return s.astype(str).str.upper().str.replace(r"[^A-Z0-9 ]", " ", regex=True).str.split().str.join(" ")

    def schools_with_name(self, center_name, province_id):
        """School IDs with the same name in the same province (how the panel decides 'is also a school')."""
        n = self.norm(pd.Series([center_name]))[0]
        s = self.schools
        return s.loc[(s["name"] == n) & (s["ProvinceId"] == province_id), "SchId"].astype(int).tolist()

    @staticmethod
    def _stack(d, keys):
        arr = [d[k] for k in keys if k in d]
        return np.vstack(arr) if arr else np.zeros((0, 3))

    @staticmethod
    def _supply(arr, T):
        s, f, n = arr[:, 0], arr[:, 1], arr[:, 2]
        lo = max(G0, T - 11)
        return {"in_training": n[(s <= T) & (f > T)].sum(), "finished_12": n[(f >= lo) & (f <= T)].sum(),
                "started_3": n[(s >= T - 2) & (s <= T)].sum()}

    # ------------------------------------------------------------------ main
    def rows(self, c):
        """c: dict with province_id, qual_ids, accreditation_month (YYYY-MM); optional city_id, region_id, school_ids,
        center_type, center_class, latitude, longitude, center_id (ignored by the model)."""
        acc0 = (pd.Period(c["accreditation_month"], "M") - START).n
        T = acc0 - 1
        if T > self.LAST:
            raise ValueError(f"accreditation_month {c['accreditation_month']} needs data up to "
                             f"{(START + T).strftime('%Y-%m')}; the data is complete only up to {(START + self.LAST).strftime('%Y-%m')}")
        prov = float(c["province_id"]); city = _num(c.get("city_id"))
        region = _num(c.get("region_id"))
        if np.isnan(region):
            region = _num(self.region_of_province.get(prov, np.nan))
        quals = sorted({int(q) for q in c["qual_ids"]})
        own = [int(s) for s in c.get("school_ids", [])]
        lo = max(G0, T - 11); n_hist = T - lo + 1

        sp = self._supply(self._stack(self.SUP_P, [(prov, q) for q in quals]), T)
        sc = self._supply(self._stack(self.SUP_C, [(city, q) for q in quals]), T) if not np.isnan(city) else None
        so = self._supply(self._stack(self.SUP_S, [(s, q) for s in own for q in quals]), T)
        comp = self._stack(self.COMP, [(prov, q) for q in quals])
        cid = c.get("center_id", -1)
        comp = comp[(comp[:, 1] >= lo) & (comp[:, 1] <= T) & (comp[:, 0] != cid)]
        n_comp = len(np.unique(comp[:, 0]))
        local_avg = comp[:, 2].sum() / n_hist
        idx = pd.MultiIndex.from_product([[prov], range(lo, T + 1)])
        pc = self.PROV_CAND.reindex(idx).fillna(0).to_numpy()
        pa = self.PROV_ACTIVE.reindex(idx).fillna(0).to_numpy()
        q = self.qual.reindex(quals)
        sec = q["SectorId"].dropna()
        base = {
            "region_id": region, "province_id": prov, "latitude": _num(c.get("latitude")), "longitude": _num(c.get("longitude")),
            "center_type": _num(c.get("center_type")), "center_class": _num(c.get("center_class")),
            "n_quals": len(quals), "n_sectors": sec.nunique(), "main_sector_id": sec.mode().iloc[0] if len(sec) else np.nan,
            "avg_level": q["LevelId"].mean(), "avg_duration_hours": q["Duration"].mean(),
            "learners_in_training_province": sp["in_training"], "learners_finished_last_12_province": sp["finished_12"],
            "learners_started_last_3_province": sp["started_3"],
            "learners_in_training_city": sc["in_training"] if sc else np.nan,
            "is_also_school": int(len(own) > 0), "own_learners_in_training": so["in_training"],
            "own_learners_finished_last_12": so["finished_12"],
            "competitor_centers": n_comp, "local_candidates_same_quals_avg": local_avg,
            "candidates_per_competitor": local_avg / max(n_comp, 1), "learners_per_center": sp["finished_12"] / (n_comp + 1),
            "province_candidates_avg": pc.mean(), "province_active_centers": pa[-1],
            "typical_center_size_province": pc.sum() / max(pa.sum(), 1),
        }
        out = []
        for k in range(1, MONTHS_AFTER + 1):
            out.append({**base, "month_since_accreditation": k, "target_month_of_year": (START + T + k).month,
                        "target_month": (START + T + k).strftime("%Y-%m")})
        return pd.DataFrame(out)
