# LightGBM Monthly Forecast — Backend Integration

This document describes how the monthly assessment-candidate forecast is generated, imported, stored and served.

Branch: `integration/models`  
Branch head: `8abb5fb`  
Model version: `lightgbm-6b4627d435e9`  
Current imported run: `2026-10`  
Seed snapshot: `seed/forecasts/2026-10/forecast_tables.sql.gz`

---

## 1. What it does

The model forecasts the number of assessment candidates 1–6 months ahead for:

- national
- region
- province
- assessment center

It answers:

> “How many candidates will there be next month and in the following 5 months in this area or center?”

This is the **monthly forecast** for existing places. It is not the New Center Model, which estimates a planned center's first year.

---

## 2. Architecture

```text
Private T2MIS raw data
(10 CSVs + Qualification.xlsx)
        |
        v
build_panel.py
        |
        v
Panel_Data.parquet
        |
        v
forecast.py
  - LightGBM region model
  - LightGBM province model
  - LightGBM center model
        |
        v
forecasts_<month>.json / .csv
forecast_meta_<month>.json
        |
        v
npm run forecast:import
        |
        v
Postgres
  forecast_runs
  forecast_values
  forecast_places
        |
        v
GET /api/v1/forecasts
GET /api/v1/forecasts/meta
```

The Python job runs outside NestJS. NestJS never loads LightGBM, Python, or the raw data.

For the current 2026-10 snapshot, the same tables can be filled without Python:

```text
seed/forecasts/2026-10/forecast_tables.sql.gz -> npm run forecast:seed -> Postgres
```

---

## 3. Inputs

### Raw data

The worker needs the same 10 CSV files and `Qualification.xlsx` used by the model team:

```text
Assessment.csv
CenterSched.csv
CenterProgram.csv
Center.csv
Enroll.csv
SchSched.csv
Schprogram.csv
School.csv
EnrollAssessment.csv
Qualification.xlsx
```

The data contains learner ULIs. It stays in a private location, for example:

```text
~/private/aga/t2mis/2026-10/Data
```

It is not committed, not in the API image, and not stored in Postgres.

### Model artifact

The model artifact is private and not committed:

```text
Forecast_Model/models/
  config.json
  lightgbm_region.txt
  lightgbm_province.txt
  lightgbm_center.txt
```

The data team supplies it. The model version is a short SHA-256 of `config.json` plus the three model files.

### Forecast month

The forecast month is the **last complete assessment month**.

Current run:

```text
forecast month: 2026-10
target months:  2026-11 .. 2027-04
```

November 2026 is partial and must not be used as the forecast month.

---

## 4. Model output

### JSON

`forecasts_2026-10.json` is an array. Each item is one place × one target month:

```json
{
  "forecast_month": "2026-10",
  "horizon": 1,
  "target_month": "2026-11",
  "level": "national",
  "place_id": "PH",
  "parent_id": "",
  "forecast_sample": 37754.4,
  "forecast_real": 188772
}
```

| Field | Meaning |
|---|---|
| `forecast_month` | Last complete assessment month |
| `horizon` | 1–6 months ahead |
| `target_month` | Month being forecast |
| `level` | `national`, `region`, `province`, `center` |
| `place_id` | Raw T2MIS RegionId / ProvinceId / CenterId; `PH` for national |
| `parent_id` | Raw parent ID |
| `forecast_sample` | Prediction at the 20% sample level |
| `forecast_real` | Full-population estimate = sample ÷ 0.2. The API shows this. |

Current run:

```text
13,092 rows
1 national
19 regions
98 provinces
2,064 centers
× 6 horizons
```

The original `forecast_out/` files were not committed and may no longer exist. The committed seed file is a **database snapshot of the imported run**, not the original raw model JSON.

### CSV

`forecasts_2026-10.csv` contains the same rows for Excel/inspection.

### Metadata

`forecast_meta_2026-10.json` contains:

- `forecast_month`
- `target_months`
- `generated_at`
- `model_version`
- `sample_rate`
- `trained_on`
- `test_accuracy`
- `versions`
- `row_count`

The importer stores this object in `forecast_runs.metadata`.

---

## 5. Place mapping

The model uses raw T2MIS IDs. The API uses PSGC codes and `assessment_centers.id`.

Committed mapping:

```text
docs/forecast/forecast_places.csv
```

Rules:

- Center IDs are direct: raw `CenterId` = `assessment_centers.id`.
- Province names come from the raw `Province` sheet and are matched to backend provinces.
- Old ARMM and new BARMM are summed into BARMM.
- Old/new Basilan, Lanao del Sur, Sulu and Tawi-Tawi are summed into their current backend province.
- Old Maguindanao is split between Maguindanao del Norte and del Sur.
- TESDA NCR districts are mapped to the four PSGC NCR districts.
- Region 20 (CO/overseas) and provinces 348/376/379/387 are excluded from Philippine area forecasts.
- New centers are handled by direct `CenterId` and current backend visibility; new provinces/regions need a mapping update.

Rebuild the mapping only after a T2MIS geography change:

```bash
npm run forecast:map -- --data-dir /path/to/Data
```

---

## 6. Import

### 6a. From a model output

```bash
npm run forecast:import -- \
  --file=forecast_out/forecasts_2026-10.json \
  --meta=forecast_out/forecast_meta_2026-10.json \
  --places=docs/forecast/forecast_places.csv \
  --replace
```

The importer validates:

- six horizons per place
- `target_month = forecast_month + horizon`
- `forecast_real = forecast_sample / sample_rate` (±1)
- national = sum of regions (±0.2)
- no duplicate place/month/horizon
- every region/province mapping target exists
- split shares add up to 1

Then it inserts the run and mapped values in one transaction.

Options:

| Option | Meaning |
|---|---|
| `--file` | Forecast JSON |
| `--meta` | Metadata JSON |
| `--places` | Mapping CSV; default `docs/forecast/forecast_places.csv` |
| `--model-version` | Override the metadata version |
| `--sample-rate` | Override the sample rate |
| `--replace` | Replace the same forecast month + model version |
| `--dry-run` | Validate and map without writing |
| `--no-places` | Do not replace the global mapping table |

### 6b. From the committed seed snapshot

The branch includes a committed 2026-10 snapshot for environments that do not have the raw data or the model artifact:

```bash
npm run db:migrate
npm run db:seed            # geography + demo accounts, only if the database is empty
npm run tesda:sync         # centers/qualifications/graduates (needs TESDA_API_KEY)
npm run forecast:seed      # fresh forecast tables
# or, when forecast data already exists:
npm run forecast:seed -- --force
```

Seed file:

```text
seed/forecasts/2026-10/forecast_tables.sql.gz
```

It is loaded inside a transaction and replaces `forecast_runs`, `forecast_values` and `forecast_places`. It needs the core backend data because `forecast_values.center_id` is a foreign key, but it does **not** need the raw T2MIS CSVs or the LightGBM model artifact.

It is a point-in-time snapshot. The API's `stale` flag will mark it old after a month; new months still need the monthly worker, the model artifact and the raw data.

Loaded output:

```text
forecast seed loaded
  forecast month: 2026-10
  model version:  lightgbm-6b4627d435e9
  source rows:    13,092
  stored values:  12,684
  places:         3,245
```

Without `--force`, the command refuses to replace existing forecast data with a clear error.

---

## 7. Database

### `forecast_runs`

One row per import:

```text
id
forecast_month       epoch seconds of the 1st, Asia/Manila
generated_at         when the Python job wrote the file
imported_at          when NestJS imported it
model_version
sample_rate
row_count
source_file
metadata             JSONB (accuracy, trained_on, versions)
```

Unique on `(forecast_month, model_version)`.

### `forecast_values`

The mapped forecast rows:

```text
run_id
level
source_place_id
parent_source_id
target_type
target_code
target_month
horizon
forecast_sample
forecast_real
share
region_psgc
province_psgc
center_id
```

For a split place, there are multiple rows with shares; the API sums `forecast_real * share`.

### `forecast_places`

The raw place → PSGC/center mapping:

```text
level
source_place_id
parent_source_id
name
target_type
target_code
share
note
```

Migration:

```text
src/database/migrations/1792600000025-Forecast.ts
```

Current 2026-10 run:

```text
forecast_runs:    1
forecast_values:  12,684
forecast_places:  3,245
```

---

## 8. API

### `GET /api/v1/forecasts/meta`

Returns:

- latest run
- forecast month
- model version
- generated/imported time
- sample rate
- accuracy
- `stale`

`stale` is true when the latest forecast month is older than the previous calendar month in Asia/Manila.

### `GET /api/v1/forecasts?level=&code=`

Examples:

```http
GET /api/v1/forecasts
GET /api/v1/forecasts?level=NATIONAL
GET /api/v1/forecasts?level=REGION&code=0600000000
GET /api/v1/forecasts?level=PROVINCE&code=0604500000
GET /api/v1/forecasts?level=CENTER&code=533
```

- Omit `level`/`code` for the user's home area.
- CO sees national and any area.
- RO sees their region and inside.
- PO sees their province and inside.

Response:

```json
{
  "run": {
    "id": "...",
    "forecastMonth": "2026-10",
    "generatedAt": 1795405703,
    "importedAt": 1795406615,
    "modelVersion": "lightgbm-6b4627d435e9",
    "sampleRate": 0.2,
    "stale": false
  },
  "accuracy": { "wape1Month": 15.22, "wape1To6": 22.85, "wape6Months": 24.52, "bias": 5.90 },
  "area": {
    "level": "REGION",
    "code": "0600000000",
    "name": "Region VI (Western Visayas)",
    "available": true,
    "forecast": [
      { "targetMonth": "2026-11", "horizon": 1, "candidates": 20076 }
    ]
  },
  "children": [
    {
      "level": "PROVINCE",
      "code": "0604500000",
      "name": "Negros Occidental",
      "available": true,
      "forecast": [
        { "targetMonth": "2026-11", "horizon": 1, "candidates": 5364 }
      ]
    }
  ],
  "coverage": { "total": 6, "withForecast": 6 }
}
```

Behavior:

- National sums the 17 Philippine region rows. The model's raw national includes CO/overseas, so the API total is slightly lower.
- Region uses the model's region rows.
- Province uses the model's province rows.
- Center uses the model's center rows.
- `candidates` = `round(sum(forecast_real * share))`.
- `forecast_sample` is not exposed.
- There is no city-level forecast.
- Centers do not add up exactly to the province forecast; use the province forecast for province totals.
- A closed/hidden center returns `available: false` with an empty forecast.
- `coverage` shows how many child areas/centers have a forecast.

---

## 9. Accuracy

Model test results (September 2025 – August 2026):

| Level | Next-month error | 1–6 month error | Bias |
|---|---:|---:|---:|
| National | 15.2% | 22.9% | +5.9% |
| Region | 23.4% | 31.1% | +5.9% |
| Province | 34.8% | 45.0% | +11.6% |
| Center | 84.7% | 104.9% | +13.0% |

Use center forecasts as a guide, not exact numbers. Show the accuracy caveat and the `stale` flag.

---

## 10. Monthly operations

For serving the existing 2026-10 snapshot without the worker, use `npm run forecast:seed` (section 6b).

To generate a new month:

1. Get the new private export.
2. Confirm the last complete assessment month with the data team.
3. Restore `Forecast_Model/models` if it is not present.
4. Run the worker:

```bash
docker run --rm \
  -v "$PWD/Forecast_Model:/app" \
  -v "$T2MIS_DATA:/data:ro" \
  -v "$PWD/forecast_out:/out" \
  python:3.11-slim \
  bash -c "apt-get update -qq && \
           apt-get install -y -qq --no-install-recommends libgomp1 >/dev/null && \
           pip install --no-cache-dir -q -r /app/requirements.txt && \
           python /app/forecast.py --data-dir /data --forecast-month 2026-10 --out /out"
```

5. Generate metadata:

```bash
npm run forecast:meta -- \
  --forecast forecast_out/forecasts_2026-10.json \
  --out forecast_out/forecast_meta_2026-10.json
```

6. Import:

```bash
npm run forecast:import -- \
  --file=forecast_out/forecasts_2026-10.json \
  --meta=forecast_out/forecast_meta_2026-10.json \
  --replace
```

7. Verify:

```http
GET /api/v1/forecasts/meta
GET /api/v1/forecasts
```

The worker can run on a small EC2/ECS task. It needs Python 3.11, `libgomp1`, the model artifact, and the private data. The API image does not need any of them.

---

## 11. Data protection

- Raw data contains learner ULIs. Keep it private and read-only for the worker.
- Do not commit `Forecast_Model/Data`, `Forecast_Model/models`, or `forecast_out`.
- The API image copies only `docs/forecast/forecast_places.csv` and the seed snapshot.
- The seed snapshot contains only place IDs and counts, no learner data.
- The output JSON contains only place IDs and counts.

---

## 12. Known limitations

- The model artifact is not in git; the data team supplies it.
- The current output files may be deleted after import; Postgres is the source of truth.
- The model is fixed at its training cutoff (August 2026). Retrain every 3–6 months.
- The current artifact expects the 20% sample (`sample_rate = 0.2`). If the data becomes full, retrain with `sample_rate = 1`.
- No city-level forecast.
- Center forecasts are coarse.
- Centers do not sum to the province forecast.
- The mapping CSV is static; new provinces/regions need a review.
- The committed seed is a 2026-10 point-in-time snapshot; it does not update automatically.
- The seed requires the core backend data (centers/provinces/qualifications) because of the center foreign key.
- The original `forecast_out` JSON/CSV/meta may be absent; the seed is the portable copy of the imported run.

---

## 13. Files and tests

```text
src/database/migrations/1792600000025-Forecast.ts
src/database/entities/forecast.entity.ts
src/forecast/forecast-import.service.ts
src/forecast/forecast.util.ts
src/forecast/forecast.service.ts
src/forecast/forecast.controller.ts
src/forecast/forecast.dto.ts
src/forecast/forecast.module.ts
src/cli/forecast-import.ts
src/cli/forecast-seed.ts
seed/forecasts/2026-10/forecast_tables.sql.gz
scripts/forecast/build-meta.py
scripts/forecast/build-place-map.py
docs/forecast/forecast_places.csv
docs/forecast/README.md
test/forecast.e2e-spec.ts
test/fixtures/
```

Tests on `integration/models`:

```text
npm run lint        passed
npm test            174/174 passed
npm run build       passed
npm run test:e2e    146/146 passed
```

`forecast:seed` was also tested manually:

- fresh load: 1 run, 12,684 values, 3,245 places
- without `--force`: refuses to replace existing data
- with `--force`: reloads successfully
