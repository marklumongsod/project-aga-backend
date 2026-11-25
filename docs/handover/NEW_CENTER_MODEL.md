# New Assessment Center Model — Backend Integration

This document describes how the planned/new assessment center model is run, mapped, stored and served.

Branch: `integration/models`  
Model version: `new-center-a3aae93e98af`  
Raw-data cutoff: `2026-10`  
Latest allowed accreditation month: `2026-11`

---

## 1. What it does

For a planned or newly accredited assessment center, the model estimates:

- the chance of getting any candidates in the first 12 months
- expected candidates in the first year
- expected candidates for each of the first 12 months

It answers:

> “If we open a center here, with these qualifications, in this month, how busy will its first year be?”

It is **not** the monthly forecast. Use it only for:

- a planned center, or
- a center accredited in the last 12 months with no candidates yet.

Once a center has assessment history, the monthly LightGBM forecast is the right model.

---

## 2. Architecture

```text
User input (NestJS)
  lat, lon, province, qualifications, accreditation month
        |
        v
NestJS validation and mapping
  PSGC -> raw ProvinceId
  qualification key -> raw QualId
  role and pin scope checks
        |
        v
Internal New Center Model service (FastAPI)
  InputBuilder loaded once (~1.2 GB)
  XGBoost count model
  LightGBM chance model
  raw data mounted read-only
        |
        v
Prediction
  chance, first year, 12 monthly rows
        |
        v
Postgres: new_center_predictions
        |
        v
POST /api/v1/new-centers/predict
```

The raw data and Python stay outside the NestJS API. NestJS never runs XGBoost or LightGBM.

---

## 3. Model

The artifact contains two models:

| Model | Library | Purpose |
|---|---|---|
| `new_center_count.json` | XGBoost | Expected candidates per month, 1–12 |
| `new_center_start.txt` | LightGBM | Chance of at least one candidate in 12 months |

Config:

```text
New_Center_Model/models/config.json
```

Key settings:

- one row per month 1–12
- `month_since_accreditation = 1` is the accreditation month
- sample rate `0.2`
- monthly predictions clipped to `[0, 1368]`
- `forecast_real = forecast_sample / 0.2`

The model was trained on 1,228 centers accredited January 2023 – September 2025.

---

## 4. Inputs

Required:

```json
{
  "province_id": 37,
  "qual_ids": [425, 142],
  "accreditation_month": "2026-11"
}
```

Optional:

```json
{
  "city_id": 931,
  "school_ids": [],
  "center_type": 2,
  "center_class": 1,
  "latitude": 14.6,
  "longitude": 121.0,
  "name": "Planned center A"
}
```

The Python service looks up the rest from the raw data:

- learners in training nearby
- learners who finished recently
- other centers assessing the same qualifications
- province market size
- school learners, if the center is also a school
- qualification sector/level/duration

---

## 5. Backend inputs

The public API uses backend-friendly inputs and maps them to raw T2MIS IDs.

### Request

```json
{
  "name": "Planned center A",
  "lat": 10.6765,
  "lon": 122.9509,
  "provincePsgc": "0604500000",
  "qualificationKeys": ["cookery ii"],
  "accreditationMonth": "2026-11",
  "centerType": 2,
  "centerClass": 1
}
```

### Mapping

Committed files:

```text
docs/new-centers/province_map.csv
docs/new-centers/qualification_map.csv
```

Current maps:

```text
88 provinces
384 qualifications
```

Rules:

- Province names come from the raw `Province` sheet and are matched to backend provinces.
- Historical BARMM duplicates use the current raw province ID.
- NCR districts use the raw TESDA district with the most centers.
- Special Geographic Area maps to Maguindanao del Sur.
- Qualifications use `QualificationTitle` + `LevelId` (Roman numeral), normalized with the same `qualificationKey()` as the dashboard.
- `city_id` is **not wired yet**. `cityKey` is accepted but not sent to the model; province + pin are used.
- `school_ids`, center type/class are optional and currently not filled by the API.

Rebuild only after a T2MIS geography change:

```bash
npm run new-center:map -- --data-dir /path/to/Data
```

---

## 6. Output

Python service output per center:

```json
{
  "name": "Planned center A",
  "accreditation_month": "2026-11",
  "chance_any_candidates": 0.293,
  "first_year_expected_sample": 18.7,
  "first_year_expected_real": 94,
  "monthly": [
    {
      "month_since_accreditation": 1,
      "target_month": "2026-11",
      "expected_sample": 0.24,
      "expected_real": 1.2
    }
  ]
}
```

`*_real` is the full-population estimate. The API shows `*_real` only.

Example validation:

```text
New_Center_Model/example_centers.json
→ chance 0.293
→ first year 94
```

---

## 7. Database

Migration:

```text
src/database/migrations/1792600000026-NewCenter.ts
```

Table: `new_center_predictions`

```text
id                  uuid
requested_by        uuid -> users
model_version       text
last_month          bigint epoch
accreditation_month bigint epoch
province_psgc       char(10)
input               jsonb (backend request + raw model input + mapping)
result              jsonb (chance, first year, monthly, accuracy)
created_at          bigint epoch
```

Each request stores a row, so the same planned center can be compared across model versions later.

---

## 8. API

### `GET /api/v1/new-centers/meta`

```json
{
  "lastMonth": "2026-10",
  "latestAccreditationMonth": "2026-11",
  "modelVersion": "new-center-a3aae93e98af",
  "sampleRate": 0.2,
  "trainedOn": "1228 new centers accredited January 2023 - September 2025",
  "testAccuracy": {
    "first_year_wape": 119.5,
    "bias_%": 27.5,
    "chance_rank_0_1": 0.56
  },
  "versions": {
    "python": "3.13.7",
    "xgboost": "3.0.5",
    "lightgbm": "4.7.0"
  },
  "loadSeconds": 8.1
}
```

The frontend should use `latestAccreditationMonth` as the maximum month in the picker.

### `POST /api/v1/new-centers/predict`

Response:

```json
{
  "id": "5e446705-18c8-45b4-8278-fb0304235f5d",
  "modelVersion": "new-center-a3aae93e98af",
  "lastMonth": "2026-10",
  "latestAccreditationMonth": "2026-11",
  "chanceAnyCandidates": 0.169,
  "firstYearExpected": 341,
  "monthly": [
    { "month": 1, "targetMonth": "2026-11", "expected": 2.8 }
  ],
  "accuracy": {
    "first_year_wape": 119.5,
    "bias_%": 27.5
  }
}
```

Validation:

- province exists
- pin is inside the province and the user's area
- CO / RO / PO scope
- qualifications exist in the mapping
- `accreditationMonth` is at most `latestAccreditationMonth`
- at least one qualification

Optional `centerType`/`centerClass` change the estimate.

---

## 9. Internal model service

Code:

```text
New_Center_Model/service.py
New_Center_Model/Dockerfile
```

Endpoints:

```http
GET  /health
GET  /meta
POST /predict
POST /reload
```

Environment:

| Variable | Meaning |
|---|---|
| `NEW_CENTER_DATA_DIR` | Raw data folder |
| `NEW_CENTER_LAST_MONTH` | Last complete month, `YYYY-MM` |
| `NEW_CENTER_MODEL_DIR` | Model folder; default `/app/models` |

Run:

```bash
docker build -t aga-new-center-model ./New_Center_Model

docker run -d --name aga-new-center-model \
  -p 127.0.0.1:8010:8010 \
  -v "$NEW_CENTER_DATA_PATH:/data:ro" \
  -e NEW_CENTER_DATA_DIR=/data \
  -e NEW_CENTER_LAST_MONTH=2026-10 \
  aga-new-center-model
```

Or with Compose:

```bash
docker compose --profile new-center up -d --build new-center-model
```

The API reaches it through:

```env
NEW_CENTER_MODEL_URL=http://localhost:8010          # host dev
NEW_CENTER_MODEL_URL=http://new-center-model:8010   # Docker Compose
```

Do not expose port `8010` publicly. The raw data contains learner IDs.

---

## 10. Accuracy

Test results (363 centers accredited January–September 2025):

| Measure | Value |
|---|---:|
| First-year error (WAPE) | 119.5% |
| Bias | +27.5% (forecasts too high) |
| Province totals error | 67.6% |
| Chance ranking (0–1) | 0.56 |

About 4 in 10 new centers got no candidates in their first year. Most start around month 3–4. Use the model to compare sites/qualifications, not as an exact number.

---

## 11. Operations

After a new monthly raw export:

1. Update `NEW_CENTER_LAST_MONTH` to the last complete month.
2. Restart or reload the service:

```bash
docker restart aga-new-center-model
```

or:

```bash
curl -X POST http://localhost:8010/reload \
  -H 'Content-Type: application/json' \
  -d '{"lastMonth":"2026-11","dataDir":"/data"}'
```

3. Check:

```http
GET http://localhost:8010/meta
```

4. Retrain every 3–6 months with the model team's notebooks and replace:

```text
New_Center_Model/models/
```

The model version hash changes automatically.

---

## 12. Data protection

- Raw data contains learner ULIs and stays private.
- `New_Center_Model/Data/` is gitignored and excluded from the Docker image.
- The API image copies only the mapping CSVs.
- The output contains only IDs and numbers.
- Keep port `8010` internal.

---

## 13. Known limitations

- No city-level mapping yet; province + pin are used.
- `school_ids`, center type/class are optional and currently not filled by the API.
- Accuracy is coarse; use for comparison.
- The model cannot predict policy changes, typhoons, or brand-new areas with no history.
- Retrain every 3–6 months.
- The model service holds ~1.2 GB of raw-data features; allocate enough memory.

---

## 14. Files and tests

```text
New_Center_Model/service.py
New_Center_Model/predict_new_center.py
New_Center_Model/new_center_inputs.py
New_Center_Model/models/
New_Center_Model/Dockerfile
src/new-centers/new-centers.module.ts
src/new-centers/new-centers.controller.ts
src/new-centers/new-centers.service.ts
src/new-centers/new-centers.dto.ts
src/new-centers/new-center-mapping.service.ts
src/new-centers/csv.ts
src/database/entities/new-center-prediction.entity.ts
src/database/migrations/1792600000026-NewCenter.ts
docs/new-centers/province_map.csv
docs/new-centers/qualification_map.csv
docs/new-centers/README.md
scripts/new-centers/build-maps.py
test/new-centers.e2e-spec.ts
```

Tests on `integration/models`:

```text
npm run lint        passed
npm test            174/174 passed
npm run build       passed
npm run test:e2e    146/146 passed
```

---

## 15. Relationship to the monthly forecast

| Center state | Model |
|---|---|
| Planned / not yet accredited | New Center Model |
| Accredited in the last 12 months, no candidates yet | New Center Model |
| Has had candidates in the last 12 months | Monthly LightGBM forecast |

The monthly forecast (`/api/v1/forecasts`) and the New Center Model (`/api/v1/new-centers`) are both on `integration/models`. They share the same Postgres; their tables coexist.
