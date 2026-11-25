# AGA Backend Handover — Forecast and New Center Model

The two model features are merged on the `integration/models` branch. They share the same Postgres database and the same private raw-data folder.

## Branches

| Branch | Feature | Endpoints |
|---|---|---|
| `integration/models` | Both model features | `/api/v1/forecasts`, `/api/v1/new-centers` |
| `staging` | Base backend + capacity utilization, no model features | — |

Switch:

```bash
git fetch origin
git switch integration/models   # both features
# or
git switch staging              # base backend only
```

## Shared setup

```bash
git clone <repo>
cd project-aga-backend
git fetch origin

cp .env.example .env
# Edit .env: DATABASE_URL, TESDA_API_KEY, etc.

docker compose up -d db
npm ci
```

Raw data stays **outside the repo**:

```text
/path/to/private/t2mis/2026-10/Data
```

It contains learner ULIs. Never commit it.

---

# 1. Monthly forecast — `/forecasts`

## What it does

Forecasts assessment candidates 1–6 months ahead for national, region, province and center level.

## Run the API

```bash
git switch integration/models
npm ci
npm run db:migrate
npm run start:dev
```

Check:

```http
GET /api/v1/forecasts/meta
GET /api/v1/forecasts
GET /api/v1/forecasts?level=REGION&code=0600000000
```

The existing 2026-10 forecast is already in the shared database. Serving it does **not** require the Python model artifact.

## Generate a new monthly forecast

The model artifact is private and not committed. Get this folder from the data team:

```text
Forecast_Model/models/
  config.json
  lightgbm_region.txt
  lightgbm_province.txt
  lightgbm_center.txt
```

Set paths:

```bash
export T2MIS_DATA=/path/to/private/t2mis/2026-10/Data
export FORECAST_MONTH=2026-10   # last complete assessment month
mkdir -p forecast_out
```

Run the worker:

```bash
docker run --rm \
  -v "$PWD/Forecast_Model:/app" \
  -v "$T2MIS_DATA:/data:ro" \
  -v "$PWD/forecast_out:/out" \
  python:3.11-slim \
  bash -c "apt-get update -qq && \
           apt-get install -y -qq --no-install-recommends libgomp1 >/dev/null && \
           pip install --no-cache-dir -q -r /app/requirements.txt && \
           python /app/forecast.py --data-dir /data --forecast-month $FORECAST_MONTH --out /out"
```

Generate metadata and import:

```bash
npm run forecast:meta -- \
  --forecast "forecast_out/forecasts_${FORECAST_MONTH}.json" \
  --out "forecast_out/forecast_meta_${FORECAST_MONTH}.json"

npm run forecast:import -- \
  --file="forecast_out/forecasts_${FORECAST_MONTH}.json" \
  --meta="forecast_out/forecast_meta_${FORECAST_MONTH}.json" \
  --replace
```

If the database has no forecast data and you only need the current 2026-10 snapshot:

```bash
npm run db:migrate
npm run db:seed            # core geography/centers, only if the database is empty
npm run forecast:seed
# replace an existing forecast snapshot:
npm run forecast:seed -- --force
```

The seed doesn't need the raw data or the model artifact. It is a point-in-time 2026-10 snapshot.

Verify:

```http
GET /api/v1/forecasts/meta
```

`forecastMonth` and `modelVersion` should be the new values.

---

# 2. New Center Model — `/new-centers`

## What it does

Estimates a planned/new assessment center’s first 12 months and the chance of getting any candidates.

## Start the internal model service

```bash
git switch integration/models
npm ci
npm run db:migrate
```

Set paths in `.env`:

```env
NEW_CENTER_MODEL_URL=http://localhost:8010
NEW_CENTER_DATA_PATH=/path/to/private/t2mis/2026-10/Data
NEW_CENTER_LAST_MONTH=2026-10
```

Build and run:

```bash
docker build -t aga-new-center-model ./New_Center_Model

docker run -d --name aga-new-center-model \
  -p 127.0.0.1:8010:8010 \
  -v "$NEW_CENTER_DATA_PATH:/data:ro" \
  -e NEW_CENTER_DATA_DIR=/data \
  -e NEW_CENTER_LAST_MONTH="$NEW_CENTER_LAST_MONTH" \
  aga-new-center-model
```

Or with Compose:

```bash
docker compose --profile new-center up -d --build new-center-model
```

Check:

```http
GET http://localhost:8010/meta
```

Expected:

```text
lastMonth: 2026-10
latestAccreditationMonth: 2026-11
```

## Run the API

```bash
npm run start:dev
```

Check:

```http
GET /api/v1/new-centers/meta
POST /api/v1/new-centers/predict
```

Example request:

```bash
curl -X POST http://localhost:3000/api/v1/new-centers/predict \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "lat": 10.6765,
    "lon": 122.9509,
    "provincePsgc": "0604500000",
    "qualificationKeys": ["cookery ii"],
    "accreditationMonth": "2026-11"
  }'
```

Expected example with `New_Center_Model/example_centers.json`:

```text
chance 0.293
first year 94
```

## Mapping

The mapping files are already committed:

```text
docs/new-centers/province_map.csv
docs/new-centers/qualification_map.csv
```

Only rebuild after a T2MIS geography change:

```bash
npm run new-center:map -- --data-dir "$NEW_CENTER_DATA_PATH"
```

---

# One API — both features

The `integration/models` branch exposes both:

- `GET /forecasts` — monthly forecast
- `GET /new-centers` — planned center estimate

Stop the API and start the merged branch:

```bash
git switch integration/models
npm run db:migrate
npm run start:dev
```

They share the same Postgres:

```text
forecast_runs / forecast_values / forecast_places
new_center_predictions
```

The forecast seed means `/forecasts` works without the LightGBM artifact or raw data. `/new-centers` still needs the internal model service and the private raw data.

## Docker images

| Image | Purpose |
|---|---|
| API image | Built from `integration/models` |
| `aga-new-center-model` | Internal FastAPI model service |
| Monthly worker | One-off `python:3.11-slim` container |

Do not expose port `8010` publicly. The raw data contains learner IDs.

## Important notes

- The monthly model artifact is **not in git**; get it from the data team.
- The new-center model artifact **is committed** in `New_Center_Model/models`.
- The raw data is not in git; keep it in the private folder.
- The monthly forecast currently in the DB is the 2026-10 run.
- To generate a new monthly forecast, update `FORECAST_MONTH` to the last complete month.
- The new-center model `NEW_CENTER_LAST_MONTH` must be updated at the same time.
- The New Center Model is for planned/new centers. Once a center has assessment history, the monthly forecast is the right model.
