"""
Reference implementation of the monthly forecast. The backend can use this file as is, or copy its predict() logic.

  1. Inputs : the panel rows to forecast (built by build_panel.py; rows with is_future = true)
  2. Predict: one LightGBM model per level (region, province, center)
  3. Rules  : clip each forecast to [0, cap]; national = sum of the regions; real count = forecast / sample_rate
  4. Output : forecasts_<month>.csv and forecasts_<month>.json (same rows)

Usage:
  python forecast.py --data-dir /path/to/Data --forecast-month 2026-08 --out /path/to/output
  python forecast.py --panel /path/to/Panel_Data.parquet --forecast-month 2026-08 --out /path/to/output

The forecast month must be the last month whose assessments are fully recorded.
"""
import argparse
import json
import os
import runpy
import time

import numpy as np
import pandas as pd
import lightgbm as lgb

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(HERE, "models")
LEVELS = ["region", "province", "center"]


def load_models(model_dir=MODEL_DIR):
    """Load the configuration and the three LightGBM models."""
    config = json.load(open(os.path.join(model_dir, "config.json"), encoding="utf-8"))
    models = {lvl: lgb.Booster(model_file=os.path.join(model_dir, config["models"][lvl]["file"])) for lvl in LEVELS}
    return config, models


def add_cap(panel):
    """cap = max(2 x the place's highest candidates_this_month up to each forecast month, 5)."""
    p = panel[["level", "place_id", "forecast_month", "candidates_this_month"]].drop_duplicates(
        ["level", "place_id", "forecast_month"]).sort_values("forecast_month")
    p["cap"] = p.groupby(["level", "place_id"])["candidates_this_month"].cummax()
    p["cap"] = np.maximum(2 * p["cap"].astype(float), 5)
    return panel.merge(p[["level", "place_id", "forecast_month", "cap"]], on=["level", "place_id", "forecast_month"], how="left")


def predict(rows, config, models, n_threads=2):
    """Forecast panel rows. rows needs: level, the features of its level, and cap. Returns sample-level forecasts."""
    out = pd.Series(np.nan, index=rows.index)
    for lvl in LEVELS:
        r = rows[rows["level"] == lvl]
        if r.empty:
            continue
        X = r[config["models"][lvl]["features"]].astype("float32")
        X["yoy_growth_3m"] = np.log(X["yoy_growth_3m"].clip(upper=10))      # the only input transform
        out.loc[r.index] = np.clip(models[lvl].predict(X, num_threads=n_threads), 0, r["cap"].to_numpy())
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--forecast-month", required=True, help="last complete month, YYYY-MM")
    ap.add_argument("--out", required=True, help="output folder")
    ap.add_argument("--data-dir", help="raw data folder; the panel is built from it")
    ap.add_argument("--panel", help="existing panel parquet (instead of --data-dir)")
    args = ap.parse_args()
    if not (args.data_dir or args.panel):
        ap.error("give --data-dir or --panel")

    t0 = time.time()
    os.makedirs(args.out, exist_ok=True)
    month = pd.Period(args.forecast_month, "M")
    panel_path = args.panel or os.path.join(args.out, "Panel_Data.parquet")
    if not args.panel:
        print(f"Building the panel up to {month} ...", flush=True)
        os.environ.update({"TCP_DATA_DIR": args.data_dir, "TCP_PANEL_PATH": panel_path, "TCP_LAST_MONTH": str(month)})
        runpy.run_path(os.path.join(HERE, "build_panel.py"), run_name="__main__")

    config, models = load_models()
    panel = pd.read_parquet(panel_path)
    for c in ["level", "place_id", "parent_id"]:
        panel[c] = panel[c].astype(str)
    panel = add_cap(panel[panel["level"].isin(LEVELS)])
    rows = panel[panel["forecast_month"] == month.to_timestamp()].copy()
    if rows.empty or rows["horizon"].nunique() < 6:
        raise SystemExit(f"The panel has no complete set of rows at {month}. Build it with that month as the last month.")

    rows["forecast"] = predict(rows, config, models, int(os.environ.get("N_THREADS", "2")))
    nat = rows[rows["level"] == "region"].groupby(["forecast_month", "horizon", "target_month"])["forecast"].sum().reset_index()
    nat["level"], nat["place_id"], nat["parent_id"] = "national", "PH", ""
    res = pd.concat([nat, rows[["level", "place_id", "parent_id", "forecast_month", "horizon", "target_month", "forecast"]]],
                    ignore_index=True)
    res["forecast_month"] = res["forecast_month"].dt.strftime("%Y-%m")
    res["target_month"] = res["target_month"].dt.strftime("%Y-%m")
    res["forecast_sample"] = res["forecast"].round(1)
    res["forecast_real"] = (res["forecast"] / config["sample_rate"]).round(0).astype(int)
    path = os.path.join(args.out, f"forecasts_{month}.csv")
    res = res.drop(columns="forecast")
    res.to_csv(path, index=False)
    res.to_json(path[:-4] + ".json", orient="records", indent=1)          # same rows, for Node.js / NestJS
    print(f"Saved {len(res):,} forecasts to {path} and {os.path.basename(path)[:-4]}.json in {time.time() - t0:.0f} s")
    print(res[res["level"] == "national"][["target_month", "forecast_real"]].to_string(index=False))


if __name__ == "__main__":
    main()
