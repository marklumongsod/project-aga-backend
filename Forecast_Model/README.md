# Assessment candidates forecast: model artifact for the backend

> The raw data (`Data/`) and the model artifact (`models/`) are private and gitignored in the backend repository.
> The worker needs them; the NestJS API does not. See `docs/forecast/README.md` for the integration.

Three LightGBM models forecast TESDA assessment candidates 1 to 6 months ahead for every region, province and assessment
center. The national forecast is the sum of the regions. Runs on an EC2 t3.large (2 vCPU, 8 GiB).

## Artifact (folder `models`)

| File | What it is |
|---|---|
| `lightgbm_region.txt` | Region model (LightGBM 4.7 text format) |
| `lightgbm_province.txt` | Province model |
| `lightgbm_center.txt` | Assessment center model |
| `config.json` | Input columns of each model (in order), input transform, cap rule, national rule, sample rate, versions, test accuracy |
| `example_input.csv` | 36 real input rows (2 places per level, 6 months ahead each) |
| `example_output.csv` | The forecast the models must return for those rows. Use it to check the integration |

Other files:

| File | What it is |
|---|---|
| `build_panel.py` | Builds the input rows from the raw data (same code as the Data Transformation notebook) |
| `forecast.py` | Reference implementation: build inputs, predict, apply the rules, write a CSV |
| `requirements.txt` | Python packages |

## How to predict (once a month)

1. **Build the inputs** from the latest raw data (the 10 CSV files and `Qualification.xlsx`):

       TCP_DATA_DIR=/path/to/Data TCP_PANEL_PATH=/path/to/Panel_Data.parquet TCP_LAST_MONTH=2026-08 python build_panel.py

   `TCP_LAST_MONTH` is the last month whose assessments are fully entered. The rows to forecast are the rows with
   `is_future = true`: one row per place and months ahead (1 to 6). About 2,100 places x 6 = 12,900 rows.

2. **Predict** each row with the model of its `level` (`region`, `province`, `center`; `national` rows are not predicted):
   - Take the columns listed in `config.json` → `models.<level>.features`, in that order.
   - Replace `yoy_growth_3m` by `log(min(yoy_growth_3m, 10))`. This is the only transform.
   - Leave missing values as missing (NaN). LightGBM handles them.

3. **Apply the rules**:
   - **Cap**: clip each prediction to `[0, cap]`, where `cap = max(2 x the place's highest candidates_this_month up to the forecast month, 5)`.
     `forecast.add_cap()` computes it from the panel.
   - **National** = sum of the 19 regional forecasts for the same forecast month and months ahead.
   - **Real count** = prediction / 0.2 (the data is about a 20% sample of learners; change `sample_rate` in `config.json` if that changes).

Python example:

    import forecast
    config, models = forecast.load_models()          # loads the three model files
    rows = forecast.add_cap(panel)                    # panel = the rows from step 1
    rows = rows[rows["forecast_month"] == "2026-08-01"]
    rows["forecast"] = forecast.predict(rows, config, models)

Or run everything at once:

    python forecast.py --data-dir /path/to/Data --forecast-month 2026-08 --out /path/to/output

It writes `forecasts_<month>.csv` with: level, place_id, parent_id, forecast_month, horizon, target_month,
forecast_sample, forecast_real.

## Check the integration

Predict the rows of `models/example_input.csv` (its `cap_max_forecast` column is the cap) and compare with
`models/example_output.csv`. The forecasts must match to about 0.001.

## Set up (once)

- Python 3.11 or newer: `pip install -r requirements.txt`
- On Linux LightGBM needs the OpenMP library. If `import lightgbm` fails with `libgomp.so.1`, install it:
  `apt-get install -y libgomp1` (Debian/Ubuntu) or `yum install -y libgomp` (Amazon Linux).
- Other languages: LightGBM has official C, C++ and C# interfaces, and the models can be converted to ONNX for Java,
  .NET or Node.js if needed.

## Resources

Full run with 2 threads (build inputs + predict): 63 seconds, 1.1 GB peak memory. Predicting alone takes under a second.

## Accuracy (test months September 2025 to August 2026)

| Level | Error next month | Error 1 to 6 months ahead | Bias |
|---|---|---|---|
| National | 15.2% | 22.9% | +5.9% |
| Region | 23.4% | 31.1% | +5.9% |
| Province | 34.8% | 45.0% | +11.6% |
| Center | 84.7% | 104.9% | +13.0% |

Error = WAPE (total error / total actual). Bias + means forecasts are too high on average.

## Things users of the forecasts should know

- Forecasts run a little high (bias above).
- The centers of a province do not add up exactly to the province forecast (in 8 of 10 cases their sum is 0.7 to 1.4 times it).
- Center forecasts are best used as a guide or added up, not as exact numbers.
- The models are fixed at what they learned up to August 2026. Accuracy will slowly drop without retraining; plan to
  retrain every 3 to 6 months with the Machine Learning Models notebook (section 11 writes new model files here).

## Data protection

The raw data contains learner IDs (ULI). The model files and the input rows contain only place IDs and counts, no
personal data. Keep the raw data in a private, encrypted location with read-only access for this job.
