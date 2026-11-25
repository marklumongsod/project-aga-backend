"""
Predict a new or planned assessment center's candidates in its first 12 months, and its chance of getting any.

Usage:
  python predict_new_center.py --data-dir /path/to/Data --last-month 2026-08 --centers centers.json --out predictions.json

centers.json: a list of centers, for example
  [{"name": "Planned center A", "province_id": 45, "city_id": 1203, "qual_ids": [101, 205],
    "accreditation_month": "2026-09", "school_ids": [], "center_type": 2, "center_class": 1}]

Required: province_id, qual_ids, accreditation_month. The accreditation month must be at most one month after the
last complete month of data (the inputs are measured in the month before accreditation).
"""
import argparse
import json
import os

import numpy as np
import pandas as pd
import lightgbm as lgb

from new_center_inputs import InputBuilder

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(HERE, "models")


def load_models(model_dir=MODEL_DIR):
    cfg = json.load(open(os.path.join(model_dir, "config.json"), encoding="utf-8"))
    cm = cfg["count_model"]
    path = os.path.join(model_dir, cm["file"])
    if cm["library"] == "xgboost":
        import xgboost as xgb
        count = xgb.Booster(); count.load_model(path)
    elif cm["library"] == "lightgbm":
        count = lgb.Booster(model_file=path)
    else:
        from catboost import CatBoostRegressor
        count = CatBoostRegressor(); count.load_model(path)
    chance = lgb.Booster(model_file=os.path.join(model_dir, cfg["chance_model"]["file"]))
    return cfg, count, chance


def predict_rows(rows, cfg, count):
    """rows: DataFrame with the count-model features. Returns expected candidates per row (sample level)."""
    cm = cfg["count_model"]
    X = rows[cm["features"]].astype(float)
    if cm["library"] == "xgboost":
        import xgboost as xgb
        p = count.predict(xgb.DMatrix(X))
    elif cm["library"] == "lightgbm":
        p = count.predict(X)
    else:
        X = X.copy()
        for c in cm["categorical"]:
            X[c] = X[c].fillna(-1).astype(int)
        p = count.predict(X)
    cap = float(cm["cap"].split(",")[1].strip(" ]"))
    return np.clip(p, 0, cap)


def predict_chance(rows, cfg, chance):
    X = rows[cfg["chance_model"]["features"]].astype(float).iloc[:1]
    return float(chance.predict(X)[0])


def predict_center(builder, center, cfg, count, chance):
    rows = builder.rows(center)
    monthly = predict_rows(rows, cfg, count)
    rate = cfg["sample_rate"]
    return {
        "name": center.get("name", ""),
        "accreditation_month": center["accreditation_month"],
        "chance_any_candidates": round(predict_chance(rows, cfg, chance), 3),
        "first_year_expected_sample": round(float(monthly.sum()), 1),
        "first_year_expected_real": int(round(float(monthly.sum()) / rate)),
        "monthly": [{"month_since_accreditation": int(r.month_since_accreditation), "target_month": r.target_month,
                     "expected_sample": round(float(m), 2), "expected_real": round(float(m) / rate, 1)}
                    for r, m in zip(rows.itertuples(), monthly)],
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--last-month", required=True, help="last complete month of data, YYYY-MM")
    ap.add_argument("--centers", required=True, help="JSON file with a list of centers")
    ap.add_argument("--out", required=True, help="output JSON file")
    args = ap.parse_args()
    cfg, count, chance = load_models()
    builder = InputBuilder(args.data_dir, args.last_month)
    centers = json.load(open(args.centers, encoding="utf-8"))
    res = [predict_center(builder, c, cfg, count, chance) for c in centers]
    json.dump(res, open(args.out, "w", encoding="utf-8"), indent=1)
    for r in res:
        print(f"{r['name'] or r['accreditation_month']}: chance {r['chance_any_candidates']:.0%}, "
              f"first year about {r['first_year_expected_real']:,} candidates")


if __name__ == "__main__":
    main()
