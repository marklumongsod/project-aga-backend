"""
Build Panel_Data.parquet from the raw data (same code as the Data Transformation notebook).

Generated automatically from "Data Transformation.ipynb". If that notebook changes, generate this file again.

Environment variables:
  TCP_DATA_DIR    folder with the 10 CSV files and Qualification.xlsx
  TCP_PANEL_PATH  where to write the panel (parquet)
  TCP_LAST_MONTH  last complete month of assessments, for example 2026-08. Forecast rows (is_future) start here.
"""
import os

import os
import gc
import numpy as np
import pandas as pd
from scipy import sparse

pd.set_option("display.max_columns", 100)
print("pandas", pd.__version__)

LOCAL_DIR = r"C:\Users\Test\Desktop\Seameo\TCP"
COLAB_DIR = "/content/drive/MyDrive/Seameo/TCP"   # change to where the TCP folder is in Drive

try:
    import google.colab  # noqa: F401
    from google.colab import drive
    drive.mount("/content/drive")
    BASE_DIR = COLAB_DIR
except ImportError:
    BASE_DIR = os.environ.get("TCP_BASE_DIR", LOCAL_DIR)

DATA_DIR = os.environ.get("TCP_DATA_DIR", os.path.join(BASE_DIR, "Data"))
XLSX = os.path.join(DATA_DIR, "Qualification.xlsx")
OUT_PATH = os.environ.get("TCP_PANEL_PATH", os.path.join(BASE_DIR, "Panel_Data.parquet"))
for f in [DATA_DIR, XLSX]:
    assert os.path.exists(f), f"Not found: {f}"

START = pd.Period("2022-01", "M")
FIRST_GOOD_MONTH = pd.Period("2022-07", "M")
LAST_OBSERVED_MONTH = pd.Period(os.environ.get("TCP_LAST_MONTH", "2026-10"), "M")
N_MONTHS = max(72, (LAST_OBSERVED_MONTH - START).n + 14)   # room for 6 future months and training schedules
HORIZONS = range(1, 7)
ACTIVE_WINDOW = 12
MIN_ACTIVE_IN_WINDOW = 1
SHARE_WINDOW = 24
SAMPLE_RATE = 0.2

G0 = (FIRST_GOOD_MONTH - START).n       # 6
LAST = (LAST_OBSERVED_MONTH - START).n  # 57
MONTHS = pd.period_range(START, periods=N_MONTHS, freq="M")

# First forecast month: every lag must stay inside the good months.
# The oldest lag is yoy_growth_3m, which reads months T-14..T-12.
FIRST_T = G0 + 14
print("Forecast months:", MONTHS[FIRST_T], "to", MONTHS[LAST], "(the last one is used for real forecasts)")

def month_index(dates):
    return (dates.dt.year - START.year) * 12 + dates.dt.month - START.month

def to_matrix(df, key, keys, mcol, weight=None):
    """Count rows per (place, month) into a places x months array."""
    M = np.zeros((len(keys), N_MONTHS))
    pos = pd.Series(np.arange(len(keys)), index=keys)
    d = df[df[key].isin(keys) & df[mcol].between(0, N_MONTHS - 1)]
    g = d.groupby([key, mcol]).size() if weight is None else d.groupby([key, mcol])[weight].sum()
    if len(g):
        i = pos.loc[g.index.get_level_values(0)].to_numpy()
        j = g.index.get_level_values(1).astype(int).to_numpy()
        np.add.at(M, (i, j), g.to_numpy())
    return M

def read_csv(name, cols, dates=()):
    df = pd.read_csv(os.path.join(DATA_DIR, name + ".csv"), usecols=cols,
                     dtype={c: "Int32" for c in cols if c not in dates},
                     na_values=["NULL", ""], keep_default_na=False)
    for c in dates:
        df[c] = pd.to_datetime(df[c], format="ISO8601", errors="coerce")
    return df.drop_duplicates().dropna(subset=[cols[0]]).reset_index(drop=True)

assess = read_csv("Assessment", ["AssessmentId", "CenterSchedId", "ULIId"])
csched = read_csv("CenterSched", ["CenterSchedId", "CenterProgramId", "DateStarted"], ["DateStarted"])
cprog = read_csv("CenterProgram", ["CenterProgramId", "CenterId", "QualId"])
center = read_csv("Center", ["CenterId", "RegionId", "ProvinceId"])

a = (assess.dropna(subset=["CenterSchedId", "ULIId"])
     .merge(csched.dropna(subset=["DateStarted"]), on="CenterSchedId")
     .merge(cprog, on="CenterProgramId")
     .merge(center, on="CenterId"))
a["m"] = month_index(a["DateStarted"])
a = a[a["m"].between(G0, LAST)]
print(f"Assessments used: {len(a):,}")

cand_rows = a.drop_duplicates(["ULIId", "CenterId", "m"])
all_centers = np.sort(cand_rows["CenterId"].unique().astype(int))
CAND_C = to_matrix(cand_rows, "CenterId", all_centers, "m")

c_info = center.set_index("CenterId").reindex(all_centers)
c_prov = c_info["ProvinceId"].to_numpy(dtype=float)
c_reg = c_info["RegionId"].to_numpy(dtype=float)
provinces = np.sort(np.unique(c_prov[~np.isnan(c_prov)])).astype(int)
regions = np.sort(np.unique(c_reg[~np.isnan(c_reg)])).astype(int)

def sum_up(M, groups, keys):
    return np.vstack([M[groups == k].sum(axis=0) for k in keys])

CAND = {
    "center": CAND_C,
    "province": sum_up(CAND_C, c_prov, provinces),
    "region": sum_up(CAND_C, c_reg, regions),
    "national": CAND_C.sum(axis=0, keepdims=True),
}

def in_panel(T):
    """Centers with candidates in at least MIN_ACTIVE_IN_WINDOW of the ACTIVE_WINDOW months up to month T."""
    return (CAND_C[:, T - ACTIVE_WINDOW + 1:T + 1] > 0).sum(axis=1) >= MIN_ACTIVE_IN_WINDOW

n_in = [int(in_panel(T).sum()) for T in range(FIRST_T, LAST + 1)]
cover = [CAND_C[in_panel(T), T + 1].sum() / CAND_C[:, T + 1].sum() for T in range(FIRST_T, LAST)]
ever = np.zeros(len(all_centers), dtype=bool)
for T in range(FIRST_T, LAST + 1):
    ever |= in_panel(T)
print(f"Centers with candidates: {len(all_centers):,}; in the panel at least once: {ever.sum():,}")
print(f"Centers in the panel per forecast month: {min(n_in):,} to {max(n_in):,} (average {np.mean(n_in):,.0f})")
print(f"They hold {np.mean(cover):.1%} of next month's candidates on average")
print(f"Provinces: {len(provinces)}, regions: {len(regions)}")
del assess, csched, cand_rows; gc.collect();

enroll = read_csv("Enroll", ["EnrollId", "SchSchedId", "ULIId", "TrainResultId"])
ssched = read_csv("SchSched", ["SchSchedId", "SchProgramId", "DateStarted", "DateFinished"], ["DateStarted", "DateFinished"])
sprog = read_csv("Schprogram", ["SchProgramId", "SchId", "QualId"])
school = read_csv("School", ["SchId", "RegionId", "ProvinceId"])

e = (enroll.dropna(subset=["SchSchedId"])
     .merge(ssched.dropna(subset=["DateStarted", "DateFinished"]), on="SchSchedId")
     .merge(sprog, on="SchProgramId")
     .merge(school, on="SchId"))
n = len(e)
e = e[e["DateFinished"] >= e["DateStarted"]].copy()
print(f"Enrollments: {n:,}; removed {n - len(e):,} with finish before start")
e["f"] = month_index(e["DateFinished"])
e["s"] = month_index(e["DateStarted"])
e["span"] = e["f"] - e["s"]
e["passed"] = (e["TrainResultId"] == 1).fillna(False).astype("int8")   # missing result = not passed (yet)
e["national"] = 1
del enroll, ssched; gc.collect()

def pipeline_matrices(d, key, keys):
    fin = to_matrix(d, key, keys, "f")
    # trainings that started before 2022 count as starting in month 0; ones that also ended before 2022 are ignored
    starts_clipped = to_matrix(d[d["f"] >= 0].assign(s0=lambda x: x["s"].clip(lower=0)), key, keys, "s0")
    return {
        "fin": fin,
        "passed": to_matrix(d, key, keys, "f", weight="passed"),
        "starts": to_matrix(d, key, keys, "s"),
        # learners in training at the end of month T: started by T and not finished by T
        "in_training": np.cumsum(starts_clipped - fin, axis=1),
        # vis[h][:, m] = learners finishing in month m whose training started at least h months earlier
        "vis": {h: to_matrix(d[d["span"] >= h], key, keys, "f") for h in range(0, 7)},
    }

LEVEL_KEY = {"province": "ProvinceId", "region": "RegionId", "national": "national"}
LEVEL_KEYS = {"center": all_centers, "province": provinces, "region": regions, "national": np.array([1])}
TRAIN = {lvl: pipeline_matrices(e.dropna(subset=[key]), key, LEVEL_KEYS[lvl]) for lvl, key in LEVEL_KEY.items()}
print("Training pipeline built for provinces, regions and national")

# One index per school + qualification
e["sq"] = e.groupby(["SchId", "QualId"], dropna=False).ngroup()
N_SQ = int(e["sq"].max()) + 1
SQ_SCHOOL = e.drop_duplicates("sq").set_index("sq")["SchId"].sort_index().to_numpy(dtype="int64")
SQ = pipeline_matrices(e, "sq", np.arange(N_SQ))

# Linked records: which school + qualification sent learners to which center, and in which month
ea = read_csv("EnrollAssessment", ["Enroll_EnrollId", "Assessment_AssessmentId"]).dropna()
links = (ea.merge(e[["EnrollId", "sq", "SchId"]], left_on="Enroll_EnrollId", right_on="EnrollId")
           .merge(a[["AssessmentId", "CenterId", "m"]], left_on="Assessment_AssessmentId", right_on="AssessmentId"))
links["cidx"] = pd.Index(all_centers).get_indexer(links["CenterId"].astype("int64"))
links["SchId"] = links["SchId"].astype("int64")
links = links[links["cidx"] >= 0]
L_SQ = links.groupby(["sq", "cidx", "m"]).size().rename("n").reset_index()
L_SCH = links.groupby(["SchId", "cidx", "m"]).size().rename("n").reset_index()
print(f"School-qualification groups: {N_SQ:,}; linked records used for the split: {len(links):,}")
del ea, links; gc.collect()

def center_weights(T):
    """Share of each school + qualification's learners going to each center, from the SHARE_WINDOW months up to T."""
    lo = T - SHARE_WINDOW + 1
    own = L_SQ[L_SQ["m"].between(lo, T)].groupby(["sq", "cidx"])["n"].sum().reset_index()
    own["w"] = own["n"] / own.groupby("sq")["n"].transform("sum")
    sch = L_SCH[L_SCH["m"].between(lo, T)].groupby(["SchId", "cidx"])["n"].sum().reset_index()
    sch["w"] = sch["n"] / sch.groupby("SchId")["n"].transform("sum")
    missing = np.setdiff1d(np.arange(N_SQ), own["sq"].unique())
    fb = pd.DataFrame({"sq": missing, "SchId": SQ_SCHOOL[missing]}).merge(sch[["SchId", "cidx", "w"]], on="SchId")
    w = pd.concat([own[["sq", "cidx", "w"]], fb[["sq", "cidx", "w"]]], ignore_index=True)
    return sparse.csr_matrix((w["w"].to_numpy(), (w["sq"].to_numpy(), w["cidx"].to_numpy())),
                             shape=(N_SQ, len(all_centers)))

CP, MAPPED_SHARE = {}, []
for T in range(FIRST_T, LAST + 1):
    Wt = center_weights(T).T.tocsr()          # centers x school-qualifications
    CP[T] = {
        "fin_last3": Wt @ SQ["fin"][:, T - 2:T + 1].sum(axis=1),
        "in_training": Wt @ SQ["in_training"][:, T],
        "starts": Wt @ SQ["starts"][:, T],
        "passed_old": Wt @ SQ["passed"][:, T - 5:T - 2].sum(axis=1),
        "fin_old": Wt @ SQ["fin"][:, T - 5:T - 2].sum(axis=1),
        "vis_t": {h: Wt @ SQ["vis"][h][:, T + h] for h in HORIZONS},
        "vis_b": {h: Wt @ SQ["vis"][h - 1][:, T + h - 1] for h in HORIZONS},
    }
    MAPPED_SHARE.append(CP[T]["in_training"].sum() / max(SQ["in_training"][:, T].sum(), 1))
print(f"Learners in training assigned to a center: {np.mean(MAPPED_SHARE):.1%} on average "
      f"(from {min(MAPPED_SHARE):.1%} to {max(MAPPED_SHARE):.1%} across forecast months)")
del SQ, L_SQ, L_SCH, e; gc.collect();

cq = pd.read_excel(XLSX, sheet_name="CenterQual", usecols=["CenterId", "Date_Accredited", "Expiration_Date"], dtype=str)
cq["CenterId"] = pd.to_numeric(cq["CenterId"], errors="coerce")
for c in ["Date_Accredited", "Expiration_Date"]:
    cq[c] = pd.to_datetime(cq[c], errors="coerce")
cq = cq.dropna()
cq["CenterId"] = cq["CenterId"].astype("Int64")
cq["acc"], cq["exp"] = month_index(cq["Date_Accredited"]), month_index(cq["Expiration_Date"])
cmap = center.set_index("CenterId")
cq["ProvinceId"] = cq["CenterId"].map(cmap["ProvinceId"])
cq["RegionId"] = cq["CenterId"].map(cmap["RegionId"])
cq["national"] = 1

def valid_count(df, key, keys, h):
    """Rows granted by month T and still valid at T+h, for every T."""
    d = df.dropna(subset=[key]).assign(start=lambda x: x["acc"].clip(lower=0), end=lambda x: x["exp"] - h + 1)
    d = d[(d["end"] > d["start"]) & (d["start"] < N_MONTHS)]
    plus = to_matrix(d, key, keys, "start")
    minus = to_matrix(d[d["end"] < N_MONTHS], key, keys, "end")
    return np.cumsum(plus - minus, axis=1)

KEY_ALL = {"center": "CenterId", **LEVEL_KEY}
ACCR = {lvl: {h: valid_count(cq, KEY_ALL[lvl], LEVEL_KEYS[lvl], h) for h in HORIZONS} for lvl in KEY_ALL}

aq = pd.read_excel(XLSX, sheet_name="AssessorQual",
                   usecols=["AssessorId", "DateofAccreditation", "DateofExpiry", "ProvinceId", "RegionId"], dtype=str)
for c in ["AssessorId", "ProvinceId", "RegionId"]:
    aq[c] = pd.to_numeric(aq[c], errors="coerce")
for c in ["DateofAccreditation", "DateofExpiry"]:
    aq[c] = pd.to_datetime(aq[c], errors="coerce")
aq = aq.dropna(subset=["AssessorId", "DateofAccreditation", "DateofExpiry"])
for c in ["AssessorId", "ProvinceId", "RegionId"]:
    aq[c] = aq[c].astype("Int64")
aq["acc"], aq["exp"] = month_index(aq["DateofAccreditation"]), month_index(aq["DateofExpiry"])
aq["national"] = 1

ASSESSORS = {}
for lvl, key in LEVEL_KEY.items():
    keys = LEVEL_KEYS[lvl]
    M = np.zeros((len(keys), N_MONTHS))
    pos = pd.Series(np.arange(len(keys)), index=keys)
    d = aq.dropna(subset=[key])
    for T in range(N_MONTHS):
        g = d[(d["acc"] <= T) & (d["exp"] >= T)].groupby(key)["AssessorId"].nunique()
        g = g[g.index.isin(keys)]
        M[pos.loc[g.index].to_numpy(), T] = g.to_numpy()
    ASSESSORS[lvl] = M

ACTIVE_CENTERS = {
    "province": sum_up(CAND_C > 0, c_prov, provinces),
    "region": sum_up(CAND_C > 0, c_reg, regions),
    "national": (CAND_C > 0).sum(axis=0, keepdims=True),
}
print(f"Center accreditations: {len(cq):,}; assessor accreditations: {len(aq):,}")
del cq, aq; gc.collect();

cc = pd.read_csv(os.path.join(DATA_DIR, "Center.csv"), usecols=["CenterId", "RegionId", "ProvinceId", "Latitude", "Longtitude"],
                 dtype=str, na_values=["NULL", ""], keep_default_na=False)
cc = cc.apply(pd.to_numeric, errors="coerce").dropna(subset=["CenterId"]).drop_duplicates("CenterId").reset_index(drop=True)

LAT_RANGE, LON_RANGE, MAX_DEG = (4.5, 21.5), (116.0, 127.0), 1.5

def in_ph(lat, lon):
    return lat.between(*LAT_RANGE) & lon.between(*LON_RANGE)

def rescale(x, lo, hi):
    x = np.abs(x.to_numpy(dtype="float64"))
    out = np.full_like(x, np.nan)
    for _ in range(20):
        hit = np.isnan(out) & (x >= lo) & (x <= hi)
        out[hit] = x[hit]
        x = np.where(x > hi, x / 10, np.nan)
    return pd.Series(out)

lat, lon = cc["Latitude"], cc["Longtitude"]
ok = in_ph(lat, lon)
swapped = ~ok & in_ph(lon, lat)
r_lat, r_lon = rescale(lat, *LAT_RANGE), rescale(lon, *LON_RANGE)
rescaled = ~ok & ~swapped & r_lat.notna() & r_lon.notna()
cc["lat"] = np.select([ok, swapped, rescaled], [lat, lon, r_lat], np.nan)
cc["lon"] = np.select([ok, swapped, rescaled], [lon, lat, r_lon], np.nan)
cc["status"] = np.select([ok, swapped, rescaled], ["ok", "swapped", "rescaled"], "invalid")

trusted = cc["status"].isin(["ok", "swapped"])
prov_med = cc[trusted].groupby("ProvinceId")[["lat", "lon"]].median()
reg_med = cc[trusted].groupby("RegionId")[["lat", "lon"]].median()
pm = cc[["ProvinceId"]].join(prov_med, on="ProvinceId")
far = ((cc["lat"] - pm["lat"]).abs() > MAX_DEG) | ((cc["lon"] - pm["lon"]).abs() > MAX_DEG)
cc.loc[far.fillna(False), "status"] = "invalid"
bad = cc["status"] == "invalid"
has_prov = bad & pm["lat"].notna()
cc.loc[has_prov, ["lat", "lon"]] = pm.loc[has_prov, ["lat", "lon"]].to_numpy()
cc.loc[has_prov, "status"] = "imputed_province"
rm = cc[["RegionId"]].join(reg_med, on="RegionId")
need_reg = (cc["status"] == "invalid") & rm["lat"].notna()
cc.loc[need_reg, ["lat", "lon"]] = rm.loc[need_reg, ["lat", "lon"]].to_numpy()
cc.loc[need_reg, "status"] = "imputed_region"

coords = cc.set_index("CenterId")
LAT = coords["lat"].reindex(all_centers).to_numpy(dtype=float)
LON = coords["lon"].reindex(all_centers).to_numpy(dtype=float)
print("Centers with candidates by coordinate status:")
print(coords["status"].reindex(all_centers).fillna("not in Center.csv").value_counts().to_string())
print(f"Centers with candidates that have coordinates: {np.isfinite(LAT).mean():.1%}")

def place_ids(lvl):
    if lvl == "national":
        return np.array(["PH"]), np.array([None], dtype=object)
    keys = LEVEL_KEYS[lvl]
    if lvl == "region":
        return keys.astype(str), np.full(len(keys), "PH", dtype=object)
    if lvl == "province":
        reg_of_prov = center.drop_duplicates("ProvinceId").set_index("ProvinceId")["RegionId"]
        return keys.astype(str), reg_of_prov.reindex(keys).astype("Int64").astype(str).to_numpy(dtype=object)
    return keys.astype(str), pd.Series(c_prov).astype("Int64").astype(str).to_numpy(dtype=object)

def mean_cols(M, a, b):
    return M[:, a:b + 1].mean(axis=1)

def pipe(lvl, T):
    """Training-pipeline values known at month T, one value per place."""
    if lvl == "center":
        return CP[T]
    TR = TRAIN[lvl]
    return {
        "fin_last3": TR["fin"][:, T - 2:T + 1].sum(axis=1),
        "in_training": TR["in_training"][:, T],
        "starts": TR["starts"][:, T],
        "passed_old": TR["passed"][:, T - 5:T - 2].sum(axis=1),
        "fin_old": TR["fin"][:, T - 5:T - 2].sum(axis=1),
        "vis_t": {h: TR["vis"][h][:, T + h] for h in HORIZONS},
        "vis_b": {h: TR["vis"][h - 1][:, T + h - 1] for h in HORIZONS},
    }

def build_level(lvl):
    C = CAND[lvl]
    n = C.shape[0]
    pid, parent = place_ids(lvl)
    chunks = []
    for T in range(FIRST_T, LAST + 1):
        rows_idx = np.nonzero(in_panel(T))[0] if lvl == "center" else np.arange(n)
        P = pipe(lvl, T)
        for h in HORIZONS:
            tm = T + h
            future = tm > LAST
            if future and T != LAST:
                continue
            f = {
                "level": lvl,
                "place_id": pid,
                "parent_id": parent,
                "forecast_month": MONTHS[T].to_timestamp(),
                "horizon": h,
                "target_month": MONTHS[tm].to_timestamp(),
                "is_future": future,
                "candidates": np.full(n, np.nan) if future else C[:, tm],
                "target_year": MONTHS[tm].year,
                "target_month_of_year": MONTHS[tm].month,
                "in_training_finishing_in_target_month": P["vis_t"][h],
                "in_training_finishing_month_before_target": P["vis_b"][h],
                "finished_last_3_months": P["fin_last3"],
                "in_training_now": P["in_training"],
                "training_starts_this_month": P["starts"],
                "grad_rate_recent": np.divide(P["passed_old"], P["fin_old"], out=np.full(n, np.nan), where=P["fin_old"] > 0),
                "candidates_this_month": C[:, T],
                "avg_candidates_last_3_months": mean_cols(C, T - 2, T),
                "avg_candidates_last_12_months": mean_cols(C, T - 11, T),
                "candidates_same_month_last_year": C[:, tm - 12],
                "active_months_last_12": (C[:, T - 11:T + 1] > 0).sum(axis=1),
                "yoy_growth_3m": (mean_cols(C, T - 2, T) + 1) / (mean_cols(C, T - 14, T - 12) + 1),
                "accredited_programs": ACCR[lvl][h][:, T],
                "active_assessors": ASSESSORS[lvl][:, T] if lvl != "center" else np.nan,
                "active_centers": ACTIVE_CENTERS[lvl][:, T] if lvl != "center" else np.nan,
            }
            if lvl == "center":
                hist = C[:, G0:T + 1] > 0
                last_active = np.where(hist.any(axis=1), hist.shape[1] - 1 - np.argmax(hist[:, ::-1], axis=1), -1)
                f["months_since_last_active"] = np.where(last_active >= 0, (T - G0) - last_active, T - G0 + 1)
                f["latitude"], f["longitude"] = LAT, LON
            else:
                f["months_since_last_active"] = np.nan
                f["latitude"] = f["longitude"] = np.nan
            chunks.append(pd.DataFrame(f).iloc[rows_idx])
    return pd.concat(chunks, ignore_index=True)

panel = pd.concat([build_level(l) for l in ["national", "region", "province", "center"]], ignore_index=True)

# Compact types
INT_COLS = ["horizon", "target_year", "target_month_of_year", "candidates", "in_training_finishing_in_target_month",
            "in_training_finishing_month_before_target", "finished_last_3_months", "in_training_now",
            "training_starts_this_month", "candidates_this_month", "candidates_same_month_last_year",
            "active_months_last_12", "accredited_programs", "active_assessors", "active_centers", "months_since_last_active"]
FLOAT_COLS = ["grad_rate_recent", "avg_candidates_last_3_months", "avg_candidates_last_12_months",
              "yoy_growth_3m", "latitude", "longitude"]
for c in INT_COLS:
    panel[c] = pd.array(np.round(panel[c].astype(float)), dtype="Int32")
for c in FLOAT_COLS:
    panel[c] = panel[c].astype("float32")
for c in ["level", "place_id", "parent_id"]:
    panel[c] = panel[c].astype("category")
panel["is_future"] = panel["is_future"].astype(bool)
panel["level"] = panel["level"].cat.reorder_categories(["national", "region", "province", "center"], ordered=True)

print(f"Panel: {len(panel):,} rows x {panel.shape[1]} columns, {panel.memory_usage(deep=True).sum() / 1e6:,.0f} MB")
print(panel.groupby("level", observed=True).agg(places=("place_id", "nunique"), rows=("horizon", "size"),
                                                 future_rows=("is_future", "sum")).to_string())

obs = panel[~panel["is_future"]]
def total(lvl):
    return obs[obs["level"] == lvl].groupby(["forecast_month", "horizon"])["candidates"].sum().astype(float)

all_center_total = pd.Series({(MONTHS[T].to_timestamp(), h): CAND_C[:, T + h].sum()
                              for T in range(FIRST_T, LAST) for h in HORIZONS if T + h <= LAST})
cen = panel[panel["level"] == "center"]
checks = {
    "one row per level, place, forecast month and horizon":
        not panel.duplicated(["level", "place_id", "forecast_month", "horizon"]).any(),
    "target month = forecast month + horizon":
        ((panel["target_month"].dt.to_period("M") - panel["forecast_month"].dt.to_period("M")).apply(lambda x: x.n)
         == panel["horizon"]).all(),
    "regions add up to national": np.allclose(total("region"), total("national")),
    "provinces add up to national": np.allclose(total("province"), total("national")),
    "all centers add up to national": np.allclose(all_center_total.sort_index(), total("national").sort_index()),
    "center rows only for centers active in the last 12 months":
        bool((cen["active_months_last_12"] >= MIN_ACTIVE_IN_WINDOW).all()),
    "learners assigned to centers never exceed the national total":
        all(CP[T]["in_training"].sum() <= TRAIN["national"]["in_training"][0, T] + 1e-6 for T in CP),
    f"no target month after {LAST_OBSERVED_MONTH.strftime('%B %Y')} in training rows": (obs["target_month"] <= LAST_OBSERVED_MONTH.to_timestamp()).all(),
    "future rows have no target": panel.loc[panel["is_future"], "candidates"].isna().all(),
    "observed rows have a target": obs["candidates"].notna().all(),
    "no negative counts": all((panel[c].dropna() >= 0).all() for c in INT_COLS),
    "no lag reaches into the start-up months": panel["forecast_month"].min() >= MONTHS[FIRST_T].to_timestamp(),
}

# Spot check: recompute one province value directly from the assessment table
row = obs[(obs["level"] == "province") & (obs["horizon"] == 1)].sample(1, random_state=0).iloc[0]
T = (row["forecast_month"].to_period("M") - START).n
direct = a[(a["ProvinceId"] == int(row["place_id"])) & (a["m"] == T)].drop_duplicates(["ULIId", "CenterId"]).shape[0]
checks["spot check: candidates_this_month matches the raw data"] = direct == row["candidates_this_month"]

for k, v in checks.items():
    print(f"{'PASS' if v else 'FAIL'}  {k}")
assert all(checks.values()), "A validation check failed"

print("Rows by level and horizon (observed rows only):")
print(obs.pivot_table(index="level", columns="horizon", values="candidates", aggfunc="size", observed=True).to_string())
print(f"\nForecast months: {panel['forecast_month'].min():%Y-%m} to {panel['forecast_month'].max():%Y-%m}")
print(f"Target months:   {obs['target_month'].min():%Y-%m} to {obs['target_month'].max():%Y-%m} (observed)")
per_month = cen[cen["horizon"] == 1].groupby("forecast_month").size()
print(f"Centers per forecast month: {per_month.min():,} to {per_month.max():,} (average {per_month.mean():,.0f}); "
      f"{cen['place_id'].nunique():,} different centers in total")
print(f"Center rows with zero candidates: {(obs.loc[obs['level'] == 'center', 'candidates'] == 0).mean():.1%}")

summary = pd.DataFrame({
    "dtype": panel.dtypes.astype(str),
    "null_%": (panel.isna().mean() * 100).round(1),
    "min": panel.min(numeric_only=True),
    "median": panel.median(numeric_only=True),
    "max": panel.max(numeric_only=True),
})
summary

panel.to_parquet(OUT_PATH, index=False, engine="pyarrow", compression="snappy")

import pyarrow.parquet as pq
meta = pq.read_metadata(OUT_PATH)
assert (meta.num_rows, meta.num_columns) == panel.shape
print(f"Saved and verified: {meta.num_rows:,} rows x {meta.num_columns} columns -> {OUT_PATH}")
print(f"File size: {os.path.getsize(OUT_PATH) / 1e6:,.1f} MB")
