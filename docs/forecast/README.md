# Assessment Candidate Forecasts

Monthly assessment-candidate forecasts for every region, province and assessment center, 1–6 months ahead.

The model is the Team C LightGBM artifact in `Forecast_Model/`. It runs **outside** the NestJS API as a monthly
Python batch job. NestJS imports the aggregate output, maps it to PSGC/center IDs, stores it in Postgres, and serves
it through `/api/v1/forecasts`.

The raw data and the model artifact are not in this repository. They stay in a private location because the raw CSVs
contain learner ULIs and the model files are owned by the data team. The worker needs the model artifact; the API
does not.

---

## 1. Architecture

```text
Private T2MIS export                      Forecast_Model/ (Python 3.11)
(10 CSV + Qualification.xlsx)                     |
        |                                         |
        +------------> monthly forecast job <-----+
                              |
                              v
                 forecasts_<month>.json
                 forecast_meta_<month>.json
                              |
                              v
                    npm run forecast:import
                              |
                              v
              forecast_runs / forecast_values / forecast_places
                              |
                              v
                    GET /api/v1/forecasts
```

Why a batch job, not a second backend:

- The model runs once a month for about a minute and peaks at ~1.1 GB. A persistent API would be idle almost all the
  time.
- Raw learner data stays in one private place, away from the public API.
- NestJS only reads small aggregate JSON; it never runs LightGBM or `build_panel.py`.
- If on-demand forecasting is needed later, the same Python code can be wrapped in FastAPI. The NestJS API and
  database contract do not change.

---

## 2. Model output contract

`forecast.py` writes `forecasts_<month>.json`, one array. Each object is one place × one target month:

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
| `forecast_sample` | Forecast at the 20% sample level |
| `forecast_real` | Full-population estimate = sample ÷ 0.2. **This is what the API shows.** |

The file has one row per place per horizon. For the October 2026 run: **13,092 rows**
(1 national, 19 regions, 98 provinces, 2,064 centers × 6 horizons).

### Metadata

`scripts/forecast/build-meta.py` writes `forecast_meta_<month>.json`:

- `forecast_month`, `target_months`
- `generated_at`
- `model_version` — short SHA-256 of `config.json` + the three LightGBM files
- `sample_rate`
- `trained_on`
- `test_accuracy` (WAPE and bias per level)
- `row_count`

The importer stores this object in `forecast_runs.metadata`.

---

## 3. Place mapping

The model uses raw T2MIS IDs. The API uses PSGC codes and `assessment_centers.id`.

- **Centers:** the raw `CenterId` is the same as `assessment_centers.id`. The importer joins directly and uses the
  center's **current** status: foreign, closed or hidden centers are excluded; visible centers are included even if
  the mapping CSV was generated when the center was hidden. The CSV center rows are an audit snapshot, not a gate.
  New centers appear automatically once they exist in `assessment_centers`.
- **Regions/provinces:** mapped by name from the `Region` and `Province` sheets in `Qualification.xlsx`, with an
  alias/override table for historical and split areas.

The mapping is generated once (and reviewed after a geography change):

```bash
npm run forecast:map
# -> docs/forecast/forecast_places.csv
```

The importer writes that CSV into `forecast_places`. A source place may have multiple target rows only when the
forecast is split; the shares must add up to 1.

Current rules:

| Raw area | Backend area |
|---|---|
| Region 15 (old ARMM) + region 19 (BARMM) | BARMM (`1900000000`), summed |
| Region 20 (CO/overseas) | Excluded |
| Provinces 348, 376, 379, 387 (overseas/CO) | Excluded |
| Provinces 7 + 84 (old/new Basilan) | Basilan (`1900700000`), summed |
| Provinces 36 + 89 (old/new Lanao del Sur) | Lanao del Sur (`1903600000`), summed |
| Provinces 66 + 90 (old/new Sulu) | Sulu (`1906600000`), summed |
| Provinces 70 + 91 (old/new Tawi-Tawi) | Tawi-Tawi (`1907000000`), summed |
| Province 38 (old Maguindanao) | Split between del Norte (`1908700000`) and del Sur (`1908800000`) |
| Provinces 92/93 (Maguindanao del Norte/Sur) | Their PSGCs |
| Province 97 (sheet says City of Isabela) | Zamboanga del Sur (`0907300000`); 32 of 34 centers are in Zamboanga City |
| TESDA NCR districts 39/74/75/76/87/88 | The four PSGC NCR districts; two TESDA districts may map to one PSGC and are summed |
| Compostela Valley / North Cotabato / Samar (Western Samar) | Davao de Oro / Cotabato / Samar |

The mapping file also carries a `note` for every alias and exclusion. Do not map by the centers' geocoded
`province_psgc`: the model's province forecast is for the raw administrative province. For example, raw province 43
is Misamis Oriental even though many of its centers geocode to Bukidnon.

---

## 4. Database

### `forecast_runs`

One row per import.

| Column | Meaning |
|---|---|
| `id` | UUID |
| `forecast_month` | Last complete assessment month, epoch seconds |
| `generated_at` | When the Python job produced the file |
| `imported_at` | When NestJS imported it |
| `model_version` | Model artifact hash/version |
| `sample_rate` | `0.2` currently |
| `row_count` | Source JSON rows |
| `source_file` | JSON filename |
| `metadata` | JSONB: accuracy, trained-on, versions |

Unique on `(forecast_month, model_version)`.

### `forecast_values`

One row per source place × target month × mapped target.

| Column | Meaning |
|---|---|
| `run_id` | FK to `forecast_runs` |
| `level` | `national`, `region`, `province`, `center` |
| `source_place_id` / `parent_source_id` | Raw T2MIS IDs |
| `target_type` / `target_code` | Mapped target |
| `target_month` | Epoch seconds |
| `horizon` | 1–6 |
| `forecast_sample` / `forecast_real` | Raw model values |
| `share` | 1, or the split share; applied when the API sums |
| `region_psgc` / `province_psgc` / `center_id` | Query keys |

Indexed by run + level + region/province/center + target month.

### `forecast_places`

The mapping table, written from `docs/forecast/forecast_places.csv`:

```text
level, source_place_id, parent_source_id, name,
target_type, target_code, share, note
```

`target_type` is `national`, `region`, `province`, `center` or `excluded`.

Migration: `src/database/migrations/1792600000022-Forecast.ts`.

---

## 5. Import

```bash
npm run forecast:import -- \
  --file=forecast_out/forecasts_2026-10.json \
  --meta=forecast_out/forecast_meta_2026-10.json \
  --replace
```

Options:

| Option | Meaning |
|---|---|
| `--file` | Forecast JSON (required) |
| `--places` | Mapping CSV; default `docs/forecast/forecast_places.csv` |
| `--meta` | Metadata JSON |
| `--model-version` | Override the metadata model version |
| `--sample-rate` | Override the sample rate (default 0.2) |
| `--replace` | Replace an existing run with the same month + model version |
| `--dry-run` | Validate and map, write nothing |
| `--no-places` | Do not replace the global `forecast_places` table |

The importer checks:

- one forecast month, all six horizons per place
- `target_month = forecast_month + horizon`
- `forecast_real = forecast_sample / sample_rate` (±1)
- national = sum of regions (±0.2)
- no duplicate place/month/horizon
- every mapping target exists
- every split's shares add up to 1

Then it stores the run and mapped values in one transaction. It never reads raw learner data.

---

## 6. API

All endpoints need an office JWT.

### `GET /api/v1/forecasts/meta`

The latest run, model version, accuracy and stale flag:

```json
{
  "latest": {
    "id": "48504915-46c0-41c1-b0cc-9b96ee9e042b",
    "forecastMonth": "2026-10",
    "generatedAt": 1795405703,
    "importedAt": 1795405849,
    "modelVersion": "lightgbm-6b4627d435e9",
    "sampleRate": 0.2,
    "stale": false
  },
  "trainedOn": "targets October 2023 to August 2026 (all complete months)",
  "accuracy": {
    "national": { "wape1Month": 15.22, "wape1To6": 22.85, "wape6Months": 24.52, "bias": 5.90 },
    "region":   { "wape1Month": 23.41, "wape1To6": 31.11, "wape6Months": 34.08, "bias": 5.90 },
    "province": { "wape1Month": 34.82, "wape1To6": 45.05, "wape6Months": 53.23, "bias": 11.61 },
    "center":   { "wape1Month": 84.71, "wape1To6": 104.91, "wape6Months": 121.11, "bias": 12.99 }
  }
}
```

`stale` is true when the latest forecast month is older than the previous calendar month in Asia/Manila.

### `GET /api/v1/forecasts`

```http
GET /api/v1/forecasts
GET /api/v1/forecasts?level=REGION&code=0600000000
GET /api/v1/forecasts?level=PROVINCE&code=0604500000
GET /api/v1/forecasts?level=CENTER&code=533
```

- Omit `level`/`code` to open the user's home area (PH for CO, own region for RO, own province for PO).
- `level=NATIONAL` is CO only.
- `level=REGION` / `PROVINCE` use the 10-digit PSGC.
- `level=CENTER` uses the assessment center id.

Response:

```json
{
  "run": {
    "id": "...",
    "forecastMonth": "2026-10",
    "generatedAt": 1795405703,
    "importedAt": 1795405849,
    "modelVersion": "lightgbm-6b4627d435e9",
    "sampleRate": 0.2,
    "stale": false
  },
  "accuracy": { "wape1Month": 23.41, "wape1To6": 31.11, "wape6Months": 34.08, "bias": 5.90 },
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

- National children are regions.
- Region children are provinces.
- Province children are centers that have a forecast.
- A center response has no children.
- `coverage.total` is the number of child areas (or visible centers in a province); `withForecast` is how many have a
  forecast row.
- `available: false` and `forecast: []` mean “no forecast yet” (for example, a closed center or a new center with no
  assessment history). The endpoint still returns 200.
- `candidates` is `forecast_real`, rounded after applying any split shares.
- The API does not expose `forecast_sample`.
- There is **no city-level forecast**. The model has no city level; do not fabricate one.

### Role scoping

| Role | Sees |
|---|---|
| CO | National, any region, any province, any center |
| RO | Own region, its provinces, their centers |
| PO | Own province, its centers |

A national request from an RO/PO is `403`; a region outside the user's scope is `403`.

---

## 7. Accuracy and presentation

Model test results (September 2025 – August 2026):

| Level | Next-month error | 1–6 month error | Bias |
|---|---:|---:|---:|
| National | 15.2% | 22.9% | +5.9% |
| Region | 23.4% | 31.1% | +5.9% |
| Province | 34.8% | 45.0% | +11.6% |
| Center | 84.7% | 104.9% | +13.0% |

Rules for the UI:

- Show the forecast month, target months and model version.
- Show the accuracy caveat for the current level.
- Center forecasts are a guide, not a promise. Do not show them as exact counts.
- Centers of a province do not add up exactly to the province forecast. Use the province forecast for province totals;
  do not sum centers.
- The national API total is the sum of the 17 Philippine regions. The model's raw national total includes the CO /
  overseas region 20, so the API total is a few counts lower. That is intentional.
- If `stale` is true, show a warning and do not present the numbers as current.

---

## 8. Local run (October 2026)

The raw data is in `Forecast_Model/Data/`. Docker cannot bind-mount `~/Documents` on this Mac, so the model is run in
a Docker volume:

```bash
docker rm -f aga-forecast-run 2>/dev/null || true
docker volume create aga-forecast-work
docker run -d --name aga-forecast-run -v aga-forecast-work:/work python:3.11-slim sleep infinity
docker cp Forecast_Model aga-forecast-run:/work/

docker exec aga-forecast-run bash -c \
  "apt-get update -qq && apt-get install -y -qq --no-install-recommends libgomp1 >/dev/null && \
   pip install --no-cache-dir -q -r /work/Forecast_Model/requirements.txt"

docker exec aga-forecast-run bash -c \
  "mkdir -p /work/out && \
   python /work/Forecast_Model/forecast.py \
     --data-dir /work/Forecast_Model/Data \
     --forecast-month 2026-10 \
     --out /work/out"

docker cp aga-forecast-run:/work/out/forecasts_2026-10.json forecast_out/
docker cp aga-forecast-run:/work/out/forecasts_2026-10.csv forecast_out/
```

Then:

```bash
npm run forecast:meta -- \
  --forecast forecast_out/forecasts_2026-10.json \
  --out forecast_out/forecast_meta_2026-10.json

npm run forecast:import -- \
  --file=forecast_out/forecasts_2026-10.json \
  --meta=forecast_out/forecast_meta_2026-10.json \
  --replace
```

Local result:

```text
source rows: 13,092
stored values: 12,684
places: 1 national, 19 regions, 98 provinces, 2,064 centers
mapped: 6 national, 108 region, 564 province, 12,000 center source rows
excluded: 0 national, 6 region, 24 province, 384 center source rows
national Nov 2026: 188,772 model / 188,759 API (overseas excluded)
```

`2026-10` is the latest complete month in this export. September and October 2026 have full assessment counts;
November 2026 is partial (3,604 candidates). Confirm with the data team before the official monthly run.

---

## 9. Monthly operations

1. The data team puts the latest private export where the worker can read it.
2. Confirm the last complete assessment month.
3. Run `forecast.py` in the Python 3.11 worker (see the Docker command above).
4. Run `build-meta.py` to record the model hash and accuracy.
5. Run `npm run forecast:import -- --file=... --meta=... --replace`.
6. Check `/api/v1/forecasts/meta`: `forecastMonth`, `modelVersion`, `stale`.
7. Check a few areas and a center.

The worker can run on ECS/EC2/cron. The API container does not need Python, LightGBM or the raw data. The output JSON
and metadata contain only place IDs and counts.

---

## 10. Data protection

`Forecast_Model/Data/` contains `Assessment.csv`, `Enroll.csv`, `Student_Profile.csv` and other files with learner
ULI identifiers. It is in `.gitignore` and must never be committed.

Also ignored:

```text
Forecast_Model/models/   # config + ~9 MB of model binaries; keep them in the private worker artifact
forecast_out/            # generated JSON/CSV
```

The model artifact, raw data and output should stay in a private, encrypted location with read-only access for the
worker. Only the aggregate output is imported into the API.

---

## 11. Known limitations

- The model forecasts national, region, province and center. There is no city/municipality forecast.
- Center accuracy is coarse. Use center forecasts as a guide.
- Centers do not sum exactly to the province forecast.
- The raw data includes historical ARMM/BARMM and old/new province duplicates. The mapping is reviewed, but the data
  team should re-check it when T2MIS changes its geography.
- The model is fixed at its training cutoff (August 2026). Retrain every 3–6 months and replace the model files; the
  importer records the new hash automatically.
- The current model artifact expects the 20% sample (`sample_rate = 0.2`); the local export matches the model's
  example input exactly. Confirm with the data team before switching to full data. If the production export is full
  data, retrain with `sample_rate = 1`; do not just change the importer.
- The forecast job is not part of `MonthlyRefreshService`. It needs the raw T2MIS export, which the API does not have.
- The province/region mapping CSV is static. New centers are handled automatically by direct `CenterId` and current
  backend status; new provinces/regions (or a changed T2MIS geography) need `npm run forecast:map` and a review.

---

## 12. Files

```text
src/database/entities/forecast.entity.ts
src/database/migrations/1792600000022-Forecast.ts
src/forecast/forecast.util.ts
src/forecast/forecast.util.spec.ts
src/forecast/forecast-import.service.ts
src/forecast/forecast.service.ts
src/forecast/forecast.controller.ts
src/forecast/forecast.dto.ts
src/forecast/forecast.module.ts
src/cli/forecast-import.ts
test/forecast.e2e-spec.ts
test/fixtures/forecast.json
test/fixtures/forecast_places.csv
test/fixtures/forecast_meta.json
scripts/forecast/build-place-map.py
scripts/forecast/build-meta.py
docs/forecast/forecast_places.csv
docs/forecast/README.md
```
