# Project AGA Backend — Full Guide

Project AGA (Assessment Center Gap Analysis) is the TESDA Team C backend: a NestJS API over
PostgreSQL/PostGIS that simulates whether assessment centers can absorb the candidates who need
National Certificate assessment, serves the CO / RO / PO dashboards, the public learner finder, a
monthly candidate forecast, and a first-year estimate for planned assessment centers.

| | |
|---|---|
| API | NestJS 11, TypeScript 5.9, Node 20+ |
| Database | PostgreSQL 16 + PostGIS 3.4, TypeORM 0.3 |
| Branch | `integration/models` |
| Version | `0.1.0` |
| Last verified | 2026-11-25 (lint, 174 unit tests, 146 e2e tests, build) |

This is the master guide. The deep dives remain the source of truth for their feature:

| Topic | Document |
|---|---|
| First-time setup, step by step | [GETTING_STARTED.md](../GETTING_STARTED.md) |
| Server hosting, security checklist | [HOSTING.md](../HOSTING.md) |
| Working rules for coding agents | [CLAUDE.md](../CLAUDE.md) |
| Frontend contract | [docs/FRONTEND_REQUIREMENTS.md](FRONTEND_REQUIREMENTS.md) |
| Monthly forecast | [docs/forecast/README.md](forecast/README.md) |
| New Center Model | [docs/new-centers/README.md](new-centers/README.md) |
| Capacity utilization | [docs/utilization/README.md](utilization/README.md) |
| Handover runbook | [docs/handover/BACKEND_HANDOVER.md](handover/BACKEND_HANDOVER.md) |

---

## 1. What the backend does

- **Office dashboards (CO / RO / PO).** KPIs, Top 5 regions / Top 3 provinces or cities, a
  choropleth map, assessment deserts, candidate density, center cards and center reach.
- **Assessment deserts and what-if.** Flags candidates with no center within the travel limit,
  computes desert levels, and lets a planner drag a proposed center onto the map to see the
  before/after and save it as a numbered proposal report.
- **Public learner finder.** No sign-in: search a place or use a location, filter by qualification,
  get the nearest centers by travel time and turn-by-turn road/ferry directions.
- **Monthly candidate forecast.** Six monthly points per area/center from the Team C LightGBM job,
  imported into Postgres; the API only serves it.
- **New Center Model.** First-12-months estimate and chance of any candidates for a planned center,
  computed by an internal Python service.
- **Capacity utilization.** Slots per center × qualification × month, assigned candidates,
  utilization and service rate for a quarter.

### Roles

| Role | Meaning | Default area | May open | May drop a pin |
|---|---|---|---|---|
| `CO` | Certification Office (Central Office) | Philippines | Every region and province | Anywhere on land |
| `RO` | Regional Office | Own region | Own region and its provinces | Inside own region |
| `PO` | Provincial Office | Own province | Own province and its cities | Inside own province |

There is no self sign-up. Accounts are seeded for the demo or provisioned from T2MIS SSO.

---

## 2. Architecture

```text
                         ┌──────────────────────────────┐
                         │  Frontend (separate repo)    │
                         │  office UI + public finder   │
                         └──────────────┬───────────────┘
                                        │ HTTPS /api/v1
                                        v
┌───────────────────────────────────────────────────────────────────┐
│ NestJS API (api:3000)                                             │
│ auth · role scope · validation · dashboards · what-if · proposals │
│ forecast serving · new-center validation/mapping/storage          │
└───────┬───────────────────────┬───────────────────────┬───────────┘
        │ SQL                   │ HTTP (internal)       │ HTTPS (sync)
        v                       v                       v
┌───────────────┐   ┌─────────────────────────┐   ┌──────────────────┐
│ PostgreSQL 16 │   │ New Center Model        │   │ TESDA Coverage   │
│ + PostGIS     │   │ FastAPI :8010           │   │ API              │
│               │   │ XGBoost + LightGBM      │   │ centers, quals,  │
│               │   │ /data ← private export  │   │ upcoming grads   │
└───────────────┘   └─────────────────────────┘   └──────────────────┘
        │
        │ optional live routing
        v
┌───────────────┐
│ OSRM :5001    │
│ road + ferry  │
└───────────────┘
```

Key boundaries:

- **NestJS is the only public backend.** It never runs Python and never reads the raw T2MIS export.
- **The New Center Model is a separate internal service.** It holds the private export and the
  model artifact, has no authentication, and must stay on a private network.
- **The forecast is a batch import.** The API serves rows; the LightGBM job runs outside the API.
- **One shared Postgres** holds both model features and the simulation.

---

## 3. Stack and requirements

| Need | Version / note |
|---|---|
| Node.js | 20 or newer (22 recommended) |
| npm | Comes with Node; lockfile is committed |
| Docker Desktop / Engine + Compose v2 | For Postgres, the API image, the model service |
| PostgreSQL + PostGIS | `postgis/postgis:16-3.4` image |
| Python | Only for the model service and the optional mapping/ETL scripts |
| RAM | ~1 GB for db + api + web; +1.2 GB for the New Center service; +1.5 GB for OSRM |
| Disk | ~1–2 GB for the app and database; +285 MB for the New Center export |

The API uses raw SQL where PostGIS is involved, otherwise TypeORM. Dates are **epoch seconds** in
`bigint` columns everywhere (team convention), and PSGC codes are 10-character strings.

---

## 4. Repository layout

```text
project-aga-backend/
├── src/
│   ├── auth/                  login, JWT strategy, T2MIS SSO (OIDC + PKCE)
│   ├── centers/               center card, reach, isochrone, utilization
│   ├── cli/                   seed-adjacent and batch commands (simulate, forecast, travel, data quality)
│   ├── common/                guards, decorators, error filter, geo/density/quarter helpers
│   ├── config/                environment contract and validation
│   ├── dashboard/             overview, map, deserts, heat, centers
│   ├── database/              entities, migrations, data source, seed, epoch transformer
│   ├── forecast/              monthly forecast serving
│   ├── health/                liveness + database readiness
│   ├── new-centers/           validation, PSGC/qualification mapping, model client, storage
│   ├── proposals/             saved what-ifs and report numbering
│   ├── public/                public finder, geo filters
│   ├── scope/                 CO / RO / PO area scoping
│   ├── simulation/            engine, travel, scheduler, what-if, recommendations
│   └── tesda/                 TESDA Coverage API client and monthly sync
├── test/                      e2e specs (app, forecast, new centers, SSO, proxy, throttling)
├── database/seed-data/        geography JSON + corrected center positions
├── seed/forecasts/2026-10/    committed forecast snapshot (SQL.gz)
├── docs/                      feature docs, handover, frontend requirements
├── Forecast_Model/            Team C monthly model code (private data/model ignored)
├── New_Center_Model/          internal FastAPI service + committed model artifact
├── scripts/                   mapping builders (forecast, new centers, OSRM)
├── etl/                       seed JSON builder (optional)
├── Dockerfile                 API image
├── docker-compose.yml         db, api, web, new-center-model, osrm profiles
└── .env.example               every supported setting
```

---

## 5. Quick start

### 5.1 Full stack in Docker

```bash
git clone <repo>
cd project-aga-backend
git switch integration/models

cp .env.example .env
# Edit .env:
#   JWT_SECRET              long random string, at least 16 characters
#   SEED_DEMO_PASSWORD      password for the three demo accounts
#   TESDA_API_KEY           required for a fresh centers/graduates sync
#   NEW_CENTER_DATA_PATH    only if you will run the New Center service

docker compose up -d db
docker compose --profile web up -d --build api web

docker compose exec api npm run db:seed:prod
docker compose exec api npm run tesda:sync:prod
docker compose exec api npm run data:quality:prod -- --apply
docker compose exec api npm run simulate:prod
docker compose exec api npm run forecast:seed:prod
```

The `web` profile builds the website from `../project-aga-frontend`, so clone that repo next to
`project-aga-backend` first. If you only need the API, use `docker compose up -d --build` instead
(no website).

Then:

- Website: `http://localhost:8080`
- API health: `http://localhost:3000/api/v1/health`
- Demo login: `co.planning@demo.aga.local` / `SEED_DEMO_PASSWORD`

The API container runs `db:migrate:prod` before it starts. Seeding, the TESDA sync, data quality,
simulation and forecast loading are one-off commands.

### 5.2 Local development

```bash
cp .env.example .env      # set JWT_SECRET, SEED_DEMO_PASSWORD, TESDA_API_KEY
docker compose up -d db
npm ci
npm run db:setup          # migrate + seed + TESDA sync + data-quality recovery
npm run simulate          # first simulation; dashboards 404 until this runs
npm run forecast:seed     # /forecasts without raw data or the model artifact
npm run start:dev         # http://localhost:3000/api/v1, Swagger at /docs in development
```

### 5.3 Demo accounts

Created by `db:seed` / `db:seed:prod` when `SEED_DEMO_PASSWORD` is set:

| Email | Role | Scope |
|---|---|---|
| `co.planning@demo.aga.local` | CO | All regions |
| `ro.region6@demo.aga.local` | RO | Region VI — Western Visayas |
| `po.negrosoccidental@demo.aga.local` | PO | Negros Occidental |

### 5.4 Model features

- **Forecast:** `npm run forecast:seed` loads the committed 2026-10 snapshot. No raw data or model
  artifact is needed to serve it.
- **New Center Model:** optional. Follow [section 12](#12-new-center-model) or
  [docs/new-centers/README.md](new-centers/README.md). It needs the private `Data` folder.

### 5.5 Command reference

| Command | Purpose |
|---|---|
| `npm run build` | Compile to `dist/` |
| `npm run start:dev` | Watch-mode API on `:3000` |
| `npm run start:prod` | Run the compiled API |
| `npm run lint` | `tsc --noEmit` (there is no ESLint) |
| `npm test` | Unit tests |
| `npm run test:e2e` | API e2e tests (seeded DB + simulation required) |
| `npm run db:migrate` / `db:revert` | Apply / undo a migration |
| `npm run db:seed` | Reload geography + corrected center positions + demo accounts |
| `npm run db:setup` | Migrate + seed + TESDA sync + data-quality recovery |
| `npm run simulate` | Run the simulation once |
| `npm run demo:utilization -- --quarter=2026-Q4` | Generate demo slots/candidates for the capacity view |
| `npm run tesda:sync` | Pull centers, qualifications and graduates |
| `npm run data:quality -- --apply` | Put back recoverable excluded centers (`--revert` undoes it) |
| `npm run forecast:seed` | Load the committed 2026-10 forecast snapshot |
| `npm run forecast:import -- --file=... --meta=...` | Import a monthly forecast artifact |
| `npm run forecast:map` | Rebuild `docs/forecast/forecast_places.csv` |
| `npm run forecast:meta -- --forecast=... --out=...` | Rebuild forecast metadata |
| `npm run new-center:map` | Rebuild `docs/new-centers/*.csv` from the raw export |
| `npm run travel:build` | Precompute the OSRM travel matrix |
| `npm run qa:travel` | Spot-check travel times |
| `npm run etl` | Rebuild `database/seed-data` from raw files |

Every batch command also has a `:prod` variant that runs the compiled JavaScript inside the API
image (for example `db:seed:prod`, `tesda:sync:prod`, `simulate:prod`, `forecast:seed:prod`).

---

## 6. Configuration

Configuration is validated at startup by `src/config/env.validation.ts`; the app refuses to start
with an invalid value. Start from `.env.example`.

### Runtime

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `test`, `production`. Swagger is off in production |
| `PORT` | `3000` | API port |
| `CORS_ORIGINS` | empty | Comma-separated allowed origins; empty = CORS disabled |
| `TRUST_PROXY` | `0` | Number of proxies in front of the API. Set `1` for nginx / one load balancer; only when the API is not directly reachable |
| `DATABASE_URL` | required | `postgresql://user:pass@host:5432/db?schema=public` |

### Authentication

| Variable | Default | Meaning |
|---|---|---|
| `JWT_SECRET` | required, min 16 chars | Signs access tokens |
| `JWT_EXPIRES_IN` | `8h` | Token lifetime |
| `SEED_DEMO_PASSWORD` | empty | Password for the three demo accounts; empty = no demo accounts |
| `T2MIS_SSO_ISSUER` | empty | SSO authority; empty = SSO off (`501`) |
| `T2MIS_SSO_CLIENT_ID` | required with issuer | SSO client id |
| `T2MIS_SSO_CLIENT_SECRET` | optional | Confidential client secret |
| `T2MIS_SSO_REDIRECT_URI` | required with issuer | Registered return URL |
| `T2MIS_SSO_APP_URL` | optional | Frontend base for the Gateway callback |
| `T2MIS_SSO_SCOPES` | `openid profile roles` | Requested scopes |
| `T2MIS_SSO_ROLE_MAP` | `CAD=CO,SU=CO,Admin=CO,RO=AUTO` | SSO role → AGA role; unlisted roles are refused |

### Simulation and routing

| Variable | Default | Meaning |
|---|---|---|
| `SIM_LIMIT_MINUTES` | `90` | Default travel limit for reach/deserts (10–180 allowed per request) |
| `SIM_MAX_SPEED_KMH` | `90` | Upper bound used only to limit the search radius |
| `SIM_CRON` | `0 2 * * *` | Daily simulation (Asia/Manila) |
| `TRAVEL_MODEL` | `estimate` | `estimate` (straight line × detour / speed + ferry) or `osrm` |
| `OSRM_URL` | `http://localhost:5001` | OSRM server |
| `OSRM_TIMEOUT_MS` | `5000` | Per-request timeout |

### TESDA sync

| Variable | Default | Meaning |
|---|---|---|
| `TESDA_API_URL` | `https://sap-sis.tesda.gov.ph` | Coverage API base |
| `TESDA_API_KEY` | empty | `X-Api-Key`. **Required for a fresh database**: centers and graduates come from this API, not from the seed JSON |
| `TESDA_API_TIMEOUT_MS` | `20000` | Request timeout |
| `TESDA_SYNC_CRON` | `45 1 1 * *` | Monthly refresh (Asia/Manila) |

### Rate limits

| Variable | Default | Meaning |
|---|---|---|
| `THROTTLE_TTL_MS` | `60000` | Window |
| `THROTTLE_LIMIT` | `60` | Unauthenticated requests per window per IP |
| `THROTTLE_OFFICE_LIMIT` | `600` | Signed-in requests per window per account |

### New Center Model

| Variable | Default | Meaning |
|---|---|---|
| `NEW_CENTER_MODEL_URL` | `http://localhost:8010` | Internal service base; Compose overrides it to `http://new-center-model:8010` |
| `NEW_CENTER_PROVINCE_MAP` | `docs/new-centers/province_map.csv` | PSGC → raw province id |
| `NEW_CENTER_QUALIFICATION_MAP` | `docs/new-centers/qualification_map.csv` | backend key → raw qualification id |
| `NEW_CENTER_LAST_MONTH` | `2026-10` (Compose) | Last complete month of the export; must match the data |
| `NEW_CENTER_DATA_PATH` | `./data/new-center` (Compose) | Host folder bind-mounted read-only at `/data` |

Secrets belong in `.env`, never in git or an image. `.env` is ignored; the `.dockerignore` also
excludes it from the API image.

---

## 7. Database

### Conventions

- PostgreSQL 16 + PostGIS 3.4.
- Schema changes only through TypeORM migrations (`synchronize: false`).
- **Dates are epoch seconds** in `bigint` columns. The API returns numbers, not ISO strings. A test
  checks that no `timestamp`/`date` column exists.
- PSGC codes are `char(10)` strings with leading zeros.
- Geometry columns use SRID 4326.
- One shared database holds simulation, forecast and New Center tables.

### Tables

| Group | Tables | Purpose |
|---|---|---|
| Geography | `regions`, `provinces`, `cities` | PSGC 2023 areas, boundaries, centroids, island ids |
| Centers | `assessment_centers`, `center_qualifications` | TESDA centers, positions, qualifications |
| Demand | `upcoming_graduates` | Upcoming graduates by province/city/qualification/month (counts, no learner ids) |
| Capacity | `center_qualification_slots` | Slots per center × qualification × month |
| Sync | `tesda_syncs`, `center_recovery_log` | Sync history and data-quality recoveries |
| Travel | `travel_times` | Precomputed city/center travel matrix |
| Simulation | `simulation_runs`, `area_utilization`, `center_utilization` | One row per run; per-area and per-center results |
| Proposals | `proposals`, `proposal_day_counters` | Saved what-ifs and daily report numbering |
| Forecast | `forecast_runs`, `forecast_places`, `forecast_values` | Imports, T2MIS-place mapping, six monthly values per place |
| New Center | `new_center_predictions` | Stored predictions per request/model version |
| Auth | `users` | Office accounts, roles, scope, SSO ids |
| Infrastructure | `migrations`, `spatial_ref_sys` | TypeORM and PostGIS |

The PostGIS image also creates `tiger` and `topology` schemas; the app does not use them.

### Migrations

All migrations live in `src/database/migrations/`:

```text
1792487911764-Init.ts
1792600000000-DropCenterSlotsOverride.ts
1792600000001-TravelTimes.ts
1792600000002-DesertColumns.ts
1792600000003-EpochDates.ts
1792600000004-CenterRecoveryLog.ts
1792600000005-EstimatedCandidates.ts
1792600000006-EpochFloor.ts
1792600000007-TesdaSync.ts
1792600000008-DropUnusedTables.ts
1792600000009-ServiceRateAdhocRuns.ts
1792600000010-DropServiceRate.ts
1792600000011-DropCapacity.ts
1792600000012-DropNextQuarter.ts
1792600000013-ReachByRoadTime.ts
1792600000014-Proposals.ts
1792600000015-ProvinceQualifications.ts
1792600000016-ProposalReportNo.ts
1792600000017-UpcomingGraduates.ts
1792600000018-RunQualification.ts
1792600000019-DropT2misQualifications.ts
1792600000020-DropBsrsStats.ts
1792600000021-Utilization.ts
1792600000022-UserNameParts.ts
1792600000023-ProposalDayNumber.ts
1792600000024-ProposalDayCounters.ts
1792600000025-Forecast.ts
1792600000026-NewCenter.ts
```

`1792600000025` and `1792600000026` are the two migrations added by this integration. They were
originally `22-Forecast` and `23-NewCenter` on the feature branches; staging had already taken
22–24, so they were renumbered.

Commands:

```bash
npm run db:migrate                        # apply pending
npm run db:revert                         # undo the last
npm run db:migrate:prod                   # compiled, in the API image
npx typeorm-ts-node-commonjs migration:generate src/database/migrations/<Name> -d src/database/data-source.ts
```

### Seed data and row counts

`database/seed-data/` contains geography (`regions.json`, `provinces.json`, `cities.json`) and 134
hand-corrected center positions (`center_corrections.json`). It does **not** contain the full center
list or candidates:

- **Centers, qualifications and upcoming graduates come from the TESDA API** via
  `npm run tesda:sync`.
- A fresh `db:setup` therefore needs a valid `TESDA_API_KEY`. Without one, restore a database dump
  instead.
- `npm run db:seed` reloads geography and the 134 corrected center positions. It also clears
  TESDA-synced centers/qualifications/graduates, simulation runs and utilization, and the seeded
  office accounts (with proposals authored by them) before re-creating the demo accounts. Re-run
  `tesda:sync`, `data:quality -- --apply` and `simulate` after it. Forecast and New Center tables are
  not touched by the seed.

A healthy local database after `db:setup` + `simulate` + `forecast:seed` looked like:

| Item | Count |
|---|---:|
| Regions | 17 |
| Provinces | 88 |
| Cities / municipalities | 1,628 |
| Assessment centers | 5,129 |
| Center × qualification rows | 14,925 |
| Upcoming graduate groups | 4,972 |
| Demo users | 3 |
| Forecast runs (2026-10) | 1 |
| Forecast places | 3,245 |
| Forecast values | 12,684 |
| New Center predictions | 9 |

---

## 8. Authentication and authorization

### Sign-in

- `POST /api/v1/auth/login` — email + password, bcrypt, returns an access token.
- `POST /api/v1/auth/sso/t2mis` — T2MIS SSO (SSOPortal / OpenIddict), authorization code + PKCE.
  The API exchanges the code, verifies the OIDC token, then finds, links or creates the account.
- `GET /api/auth/callback` and `GET /api/v1/auth/callback` — SSOPortal's Gateway-format return
  address; 302 to the frontend with `code` and `state`.
- `GET /api/v1/auth/me` — the user and their scope.
- Tokens are JWT Bearer tokens, valid for `JWT_EXPIRES_IN` (8h default). There is no refresh token.

### Enforcement

Three global guards run in order:

1. `JwtAuthGuard` — every route requires a token unless marked `@Public()`.
2. `AppThrottlerGuard` — rate limits by account when signed in, otherwise by IP.
3. `RolesGuard` — enforces `@Roles(...)` when present.

`AreaScopeService` enforces the data scope:

| Role | Home | Allowed |
|---|---|---|
| CO | Philippines | Any area |
| RO | Own region | Own region + its provinces/cities |
| PO | Own province | Own province + its cities |

`level=NATIONAL` is CO-only. Pins must fall inside the user's area (500 m shore allowance).

### SSO notes

- SSO is off while `T2MIS_SSO_ISSUER` is empty; the endpoints return `501`.
- Unlisted SSO roles are refused (`403`).
- Role and area are refreshed from claims at every sign-in; `is_active = false` blocks an account.
- `T2MIS_SSO_ROLE_MAP` decides the mapping; `AUTO` means PO when a province resolves, otherwise RO.

---

## 9. API reference

### Conventions

- Base path: `/api/v1` (URI versioning). The SSO callback is also available unversioned at
  `/api/auth/callback`.
- Office routes need `Authorization: Bearer <token>`. Public routes are marked below.
- JSON in, JSON out. `ValidationPipe` whitelists fields: unknown body/query fields return `400`.
- Dates are epoch seconds.
- Errors use standard NestJS shapes: `400` validation, `401` missing/expired token, `403` role or
  area, `404` not found/no run, `503` optional service or routing unavailable.
- Rate limits: public 60/min per IP, office 600/min per account; sign-in 10/min; SSO config and
  callback 30/min; health is exempt.

### Health and auth

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | public | Liveness + database ping |
| POST | `/auth/login` | public | Email/password → JWT |
| GET | `/auth/sso/t2mis` | public | SSO start configuration; `501` when off |
| GET | `/api/auth/callback` | public | SSOPortal return → frontend |
| POST | `/auth/sso/t2mis` | public | Exchange code + verifier → JWT |
| GET | `/auth/me` | office | User + area scope |

### Dashboards

All office routes accept `level`, `code`, `limitMinutes` (10–180), `qualification` and `quarter`
(where meaningful).

| Method | Path | Purpose |
|---|---|---|
| GET | `/dashboard/qualifications` | Qualification filter options |
| GET | `/dashboard/overview` | KPIs, Top 5 / Top 3, all child areas, desert summary, legends |
| GET | `/dashboard/map` | GeoJSON choropleth of child areas |
| GET | `/dashboard/deserts` | Desert cities with shapes |
| GET | `/dashboard/heat` | Every city as a point with candidates/flagged |
| GET | `/dashboard/centers` | Centers in the area with predicted candidates |

`overview` returns `run`, `quarter`, `qualification`, `area`, `childLevel`, `top`, `rows`,
`deserts`, `desertLegend`, `densityLegend` and, on a capacity run, `utilizationLegend`.

Adding `qualification` + `quarter` runs a one-off capacity simulation (kept for 30 minutes) and adds
`slots`, `assigned`, `utilization`, `serviceRate` and `utilizationBand`.

### Centers

| Method | Path | Purpose |
|---|---|---|
| GET | `/centers/:id` | Center card: details, qualifications, predicted candidates |
| GET | `/centers/:id/utilization?quarter=` | Capacity per qualification for a quarter |
| GET | `/centers/:id/reach` | Cities by travel time to the center |
| GET | `/centers/:id/isochrone` | 30/60/90-minute drive-time polygons; needs OSRM |

### Simulation / what-if

| Method | Path | Purpose |
|---|---|---|
| GET | `/simulation/recommendations` | Up to 5 sites that close the most deserts, best first |
| GET | `/simulation/snap` | Move a hand-placed pin onto the nearest road |
| GET | `/simulation/reach` | Cities a proposed center reaches, GeoJSON |
| GET | `/simulation/isochrone` | True drive-time areas around a pin |
| POST | `/simulation/what-if` | Before/after for the user's area, nationally, and the pin's region/province |

`what-if` body: `{ lat, lon, name?, level?, code?, limitMinutes? }`. It returns `pin`, `newlyServed`,
`pinDemand`, `limitMinutes`, `area`, `national`, `placeAreas`, `improvedCities` and, for saved
proposals, a `report`.

### Proposals

| Method | Path | Purpose |
|---|---|---|
| POST | `/proposals` | Save a what-if; the server computes and stores the result |
| GET | `/proposals` | List proposals visible to the user |
| GET | `/proposals/:id` | Full proposal + stored result |
| PATCH | `/proposals/:id` | Rename (author or CO) |
| DELETE | `/proposals/:id` | Delete (204) |

Report numbers are `GA-yyyymmdd-#`, numbered per Asia/Manila day.

### Forecast

| Method | Path | Purpose |
|---|---|---|
| GET | `/forecasts/meta` | Latest run, model version, accuracy, `stale` |
| GET | `/forecasts?level=&code=` | Six monthly points + children; scoped by role |

`level`: `NATIONAL`, `REGION`, `PROVINCE`, `CENTER`. Omit it to open the user's home area.
`code`: PSGC for region/province, center id for `CENTER`. `CENTER` returns `available: false` and a
note for foreign/closed/hidden centers or no recent history.

Response: `run`, `accuracy`, `area` (`level`, `code`, `name`, `available`, `forecast`, `note`),
`children`, `coverage`.

### New Center Model

| Method | Path | Purpose |
|---|---|---|
| GET | `/new-centers/meta` | Cutoff, latest accreditation month, model version, accuracy |
| POST | `/new-centers/predict` | First-year estimate for a planned center |

Body:

```json
{
  "name": "Planned center A",
  "lat": 10.6765,
  "lon": 122.9509,
  "provincePsgc": "0604500000",
  "cityKey": "0604501000",
  "qualificationKeys": ["cookery ii"],
  "accreditationMonth": "2026-11",
  "centerType": 2,
  "centerClass": 1
}
```

Required: `lat`, `lon`, `provincePsgc`, at least one qualification key, `accreditationMonth`.
The pin must be inside the province and the user's area. Response: `id`, `modelVersion`,
`lastMonth`, `latestAccreditationMonth`, `chanceAnyCandidates`, `firstYearExpected`, 12 `monthly`
rows, optional `accuracy`.

### Public and geo

| Method | Path | Purpose |
|---|---|---|
| GET | `/public/stats` | Centers and qualifications counts, desert legend |
| GET | `/public/places?q=` | Place search (2–80 chars) |
| GET | `/public/qualifications?q=` | Qualification filter |
| GET | `/public/centers/nearest` | Nearest centers by `lat`/`lon` or `cityKey`; optional qualification/region/province; `limit` 1–20 |
| GET | `/public/route` | Road + ferry route to one center; needs OSRM |
| GET | `/geo/regions` | Regions for filters |
| GET | `/geo/regions/:psgc/provinces` | Provinces of a region |

The public finder never returns learner or congestion data.

---

## 10. Simulation engine

### Demand

- Demand is `upcoming_graduates`: everyone finishing training in the next 6 months.
- About 77% are placed in a town by the API and count there. The rest are placed only in a province
  and split over its towns: 20% evenly, 80% by each town's own graduates.
- `estimatedCandidates` on a city is the split part, not a direct count.

### Reach and deserts

- Reach is by **road travel time** (and ferry), never by straight-line distance.
- `TRAVEL_MODEL=estimate` uses straight-line distance × detour / speed, plus a ferry allowance.
- `TRAVEL_MODEL=osrm` uses real routes from the OSRM server and a precomputed matrix.
- A city is an **assessment desert** when it has candidates and no center within the travel limit.
- Desert levels by candidates: 1 = 1–20, 2 = 21–40, 3 = 41–60, 4 = 61+.
- Provinces and regions carry the number of desert cities inside and the highest level.

### Density and hotspots

- Density = candidates in an area whether or not a center is nearby.
- Sibling areas are split into quintiles; the densest fifth is the hotspot.

### Capacity utilization

- Slots are stored monthly per center × qualification in `center_qualification_slots`.
- A quarter is the sum of its three months.
- The demo rule is **20 slots per program per center per month** (60 per quarter). Demo rows are
  marked `source = 'demo'`.
- `utilization = candidates wanting the center ÷ quarter slots` (can exceed 1).
- `assigned` = candidates actually placed in an open slot; `serviceRate = assigned ÷ candidates`.
- Assignment is capacity-aware: each qualification's candidates go to the nearest accredited center
  with an open slot within the limit; overflow goes to the next reachable center; anyone left is
  flagged.

### What-if and recommendations

- What-if re-runs the check with a proposed center and returns before/after for the user's area,
  nationally, and the pin's region/province.
- It caches its baseline for 10 minutes. Run one API replica: a second replica would not see the
  first one's refreshed baseline.
- Recommendations pick desert cities that close the most deserts, move the pin onto the nearest
  road, and suggest the top qualifications to offer from graduate data.

---

## 11. Monthly forecast

### Data flow

```text
private T2MIS export
        │
        ▼
Forecast_Model/forecast.py (LightGBM, outside the API)
        │  forecasts_<month>.json + forecast_meta_<month>.json
        ▼
npm run forecast:import  ──► forecast_runs / forecast_places / forecast_values
        │
        ▼
GET /api/v1/forecasts
```

The API never runs Python or reads learner data. The importer maps raw T2MIS place ids to
PSGC/center ids with `docs/forecast/forecast_places.csv`, applies `share` for split places, and
stores the result.

### Seed instead of import

For environments without the raw export or model artifact:

```bash
npm run forecast:seed          # load seed/forecasts/2026-10/forecast_tables.sql.gz
npm run forecast:seed -- --force
```

The committed snapshot is the current served forecast. `forecast:import` is the monthly path when
the data team provides a new artifact.

### API and accuracy

- `GET /forecasts/meta` returns the latest run, `forecastMonth`, `modelVersion`, `sampleRate`,
  `stale`, and accuracy from the run metadata.
- `stale` is true when a newer monthly run should already exist.
- Model test results (September 2025 – August 2026):

| Level | Next-month error | 1–6 month error | Bias |
|---|---:|---:|---:|
| National | 15.2% | 22.9% | +5.9% |
| Region | 23.4% | 31.1% | +5.9% |
| Province | 34.8% | 45.0% | +11.6% |
| Center | 84.7% | 104.9% | +13.0% |

- Center forecasts are a guide; centers do not sum exactly to the province.
- The API national total is the sum of the 17 Philippine regions; the model's raw national total
  includes the overseas region 20, so the API total is slightly lower.

Current state: one run, `2026-10`, `lightgbm-6b4627d435e9`, 3,245 places, 12,684 values.

The future monthly artifact (`Forecast_Model/models`) is still private and not present in every
environment. The seed covers the current served month.

---

## 12. New Center Model

### What it is

A first-12-months estimate for a planned center, or a center accredited in the last 12 months with
no candidates yet. It is separate from the monthly forecast: use it before history exists, and use
the forecast once a center has assessment history.

### Architecture

```text
NestJS /api/v1/new-centers/predict
        │  validates role, pin, province, qualification keys, month
        │  maps PSGC/keys → raw T2MIS ids
        ▼
New Center Model (FastAPI :8010)
        │  InputBuilder loads the private export once (~1.2 GB, 10–25 s)
        │  XGBoost count model + LightGBM chance model
        ▼
chanceAnyCandidates, firstYearExpected, 12 monthly rows
        │
        ▼
NestJS stores the request/result in new_center_predictions and returns camelCase
```

### Why it needs the raw data

The committed artifact (`New_Center_Model/models/`, ~508 KB) contains the trained trees only. At
startup the service builds the model inputs from the export:

| File | Used for |
|---|---|
| `Assessment.csv`, `CenterSched.csv`, `CenterProgram.csv` | past assessments per center/qualification/month |
| `Enroll.csv`, `SchSched.csv`, `Schprogram.csv`, `School.csv` | learner supply by province/city/school |
| `Center.csv` | geography, type, region |
| `Qualification.xlsx` | sector, level, duration |

The service reads 8 CSVs + `Qualification.xlsx` at inference. The full 2026-10 export has 10 CSVs +
the xlsx (284 MB), including `EnrollAssessment.csv` and `Student_Profile.csv`, which inference does
not read.

This history is not available from the TESDA Coverage API, which only exposes centers,
qualifications and upcoming graduates.

### Deployment

Build and run with the export mounted read-only:

```bash
docker build -t aga-new-center-model New_Center_Model

docker run -d --name aga-new-center-model \
  -p 127.0.0.1:8010:8010 \
  -v /path/to/private/t2mis/2026-10/Data:/data:ro \
  -e NEW_CENTER_LAST_MONTH=2026-10 \
  aga-new-center-model
```

Or Compose:

```bash
NEW_CENTER_DATA_PATH=/path/to/private/t2mis/2026-10/Data \
  docker compose --profile new-center up -d --build new-center-model
```

The Compose API reaches it at `http://new-center-model:8010`. For host development set:

```env
NEW_CENTER_MODEL_URL=http://localhost:8010
```

The data is a **bind mount**, not a copy. Keep the folder for as long as the service runs. Port
`8010` must stay private: the export contains learner ids. The image contains code + artifact, not
the export.

### API contract

- `GET /health` — status, last month, model version, load time.
- `GET /meta` — cutoff, latest accreditation month, model version, sample rate, training summary,
  test accuracy, library versions.
- `POST /predict` — one or more centers; validates `accreditation_month` against the cutoff.
- `POST /reload` — reload after a new monthly export.

The public NestJS contract is `GET /new-centers/meta` and `POST /new-centers/predict`.

### Accuracy

From the model's test period (363 centers accredited January–September 2025):

| Measure | Value |
|---|---:|
| First-year WAPE | 119.5% |
| Bias | +27.5% |
| WAPE if level is right | 106.9% |
| Province totals WAPE | 67.6% |
| Chance ranking (0–1) | 0.56 |

Use it to compare sites, not to promise an exact number.

### Current state

- Model version `new-center-a3aae93e98af`, cutoff `2026-10`, latest accreditation month `2026-11`.
- Local service validated at ~0.169 chance / 341 first-year candidates / 12 months for the sample pin.
- City-level mapping is not wired: `cityKey` is accepted but the model uses province + pin.

### Options to avoid the raw data per backend

1. **Share one model service** (recommended): one host has the export; every backend sets
   `NEW_CENTER_MODEL_URL`. The other backend needs no data.
2. **Feature snapshot**: commit the aggregates the model uses (a few MB, no learner ids) and load
   them instead of the raw export. Needs a loader change and a monthly rebuild.
3. **Feature API**: the data team exposes aggregate endpoints; the service fetches them at startup.

Raw data must never be committed or baked into a shareable image.

---

## 13. Capacity utilization

- `center_qualification_slots` stores one row per center × qualification × month.
- A quarter is the sum of three months.
- The demo generator adds 20 slots per program per center per month (60 per quarter).
- `utilization = candidates / slots`; above 1 means demand exceeds capacity.
- `assigned` is capacity-limited; `serviceRate = assigned / candidates`.
- `utilizationBand` maps to `utilizationLegend` (green → red).
- Endpoints: `/dashboard/*?qualification=&quarter=`, `/centers/:id/utilization?quarter=`.
- Demo:

```bash
npm run demo:utilization -- --quarter=2026-Q4
```

If the database has real upcoming graduates, only slots are generated; otherwise demo candidates
are added too. Demo rows are marked `source = 'demo'`.

---

## 14. Data sources and privacy

| Source | What it provides | Where it goes |
|---|---|---|
| PSGC 2023 boundary files | regions, provinces, cities, geometry | `database/seed-data/*.json` (committed) |
| TESDA Coverage API | centers, qualifications, upcoming graduates | synced into Postgres |
| Team C T2MIS export | historical assessment/enrollment for the New Center Model | private folder, mounted read-only |
| Team C forecast output | monthly aggregate JSON | imported into `forecast_*` |
| OpenStreetMap | road/ferry routing | OSRM container + `travel_times` |

Privacy rules:

- The API stores no learner personal data (RA 10173). Upcoming graduates are counts, not people.
- The New Center export contains ULI learner ids. Keep it outside git and images, mount it read-only,
  and never expose port `8010` publicly.
- `data/raw/`, `Forecast_Model/Data/`, `Forecast_Model/models/` and `New_Center_Model/Data/` are
  ignored. The New Center model artifact itself is committed; the raw export is not.
- The public finder returns no learner, congestion or flagged data.

---

## 15. Scheduled jobs and operations

Both jobs run inside the API process, in Asia/Manila, through one queue so they never overlap.

| Job | Default | What it does |
|---|---|---|
| Monthly refresh | `45 1 1 * *` (`TESDA_SYNC_CRON`) | TESDA sync → data-quality recovery → travel times for changed centers → simulation |
| Daily simulation | `0 2 * * *` (`SIM_CRON`) | Re-runs the simulation on the last synced data |

- A failing step is logged; the next step still runs on the last good data.
- **Run one API replica.** Two replicas would both run the jobs, and the what-if baseline is
  process-local.
- History: the latest run of each day for 90 days, plus the last run of each quarter forever.
- Forecast and New Center refreshes are not in these cron jobs:
  - Forecast: run `forecast:import` after the data team delivers a new artifact, or
    `forecast:seed` for the committed snapshot.
  - New Center: replace the data folder, update `NEW_CENTER_LAST_MONTH`, restart the container
    (or `POST /reload`).

Health and logs:

```bash
curl -s http://localhost:3000/api/v1/health
curl -s http://localhost:8010/health
docker compose logs -f api
docker compose logs -f new-center-model
```

Backups:

```bash
docker compose exec -T db pg_dump -U aga -Fc aga > aga-$(date +%F).dump
```

Back up the private New Center data folder separately.

---

## 16. Deployment

### Compose services and profiles

| Service | Profile | Port | Notes |
|---|---|---|---|
| `db` | default | 5432 | PostGIS; named volume `pgdata` |
| `api` | default | 127.0.0.1:3000 | Runs migrations on start |
| `web` | `web` | 8080 | nginx + built frontend; needs `../project-aga-frontend` |
| `new-center-model` | `new-center` | 127.0.0.1:8010 | Needs `NEW_CENTER_DATA_PATH` |
| `osrm` | `routing` | 5001 | Optional road/ferry routing |

### One server

```bash
cp .env.example .env
# JWT_SECRET, SEED_DEMO_PASSWORD, TESDA_API_KEY, NEW_CENTER_* as needed

docker compose up -d db
docker compose --profile web up -d --build api web
docker compose exec api npm run db:seed:prod
docker compose exec api npm run tesda:sync:prod
docker compose exec api npm run data:quality:prod -- --apply
docker compose exec api npm run simulate:prod
docker compose exec api npm run forecast:seed:prod

# optional model service
NEW_CENTER_DATA_PATH=/srv/private/aga/t2mis/2026-10/Data \
  docker compose --profile new-center up -d --build new-center-model
```

Put TLS in front of port 8080. Set `TRUST_PROXY=1` only when the API is reachable only through the
proxy. Keep `3000`, `5432` and `8010` private.

### API-only

```bash
docker compose up -d --build      # db + api
```

or run the API on the host with `npm run start:dev` against the Compose database.

### Updates

```bash
git pull
docker compose --profile web up -d --build api web
```

Migrations run on API start. Rebuild `new-center-model` when `New_Center_Model/` changes. After a
new OSM extract or routing profile change, run `travel:build:prod` and `simulate:prod`.

### Verification

```bash
curl -s localhost:3000/api/v1/health
curl -s localhost:8010/health
```

Then sign in and check:

- `/api/v1/forecasts/meta` → latest run `2026-10`
- `/api/v1/new-centers/meta` → cutoff `2026-10`
- one prediction → ~chance `0.169`, first year `341`, 12 months

---

## 17. Testing and quality

```bash
npm run lint          # tsc --noEmit
npm test              # 174 unit tests, 23 suites
npm run test:e2e      # 146 e2e tests, 6 suites (needs a seeded DB + simulation)
npm run build
```

E2E prerequisites: a running database, `db:setup`, `npm run simulate`, and the API test app starts
itself. The e2e suite covers the app, forecast, new centers, SSO, proxy trust and throttling.

Unit tests cover the simulation engines, demand split, travel helpers, density/rate bands, quarter
helpers, forecast utilities, new-center CSV mapping, TESDA parsing and scheduler behavior.

Before calling a change done: `npm run lint && npm test`, plus `npm run test:e2e` if you touched a
controller, service, query or migration.

---

## 18. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Invalid environment configuration` | Missing/short `JWT_SECRET`, bad `DATABASE_URL`, invalid enum | Compare `.env` with `.env.example`; `JWT_SECRET` ≥ 16 chars |
| `TESDA API ... needs TESDA_API_KEY` | Fresh DB with no key | Set `TESDA_API_KEY`, or restore a database dump |
| Dashboards return 404 / "No simulation" | `npm run simulate` has not run | Run it, or use "Run now" as CO |
| `/forecasts` returns 404/empty | Forecast not imported/seeded | `npm run forecast:seed` |
| `/new-centers` returns 503 | Model service down or `NEW_CENTER_MODEL_URL` wrong | Start the container; check `:8010/health` |
| New Center container restarts | Wrong `NEW_CENTER_DATA_PATH` or month mismatch | Logs show the missing file; the path must directly contain `Assessment.csv`; `NEW_CENTER_LAST_MONTH` must match the export |
| `port is already allocated` | Another process uses 3000/8080/8010/5432 | Stop it or change the host port |
| SSO endpoints return 501 | SSO not configured | Set the `T2MIS_SSO_*` values |
| 429 "Too many attempts" | Rate limit | Wait for the window; check `TRUST_PROXY` |
| Map has colors but no streets | Offline basemap | Reload when online; the app still works |
| OSRM routes unavailable | Routing server down | It falls back to the estimate; check the `routing` profile |
| Apple Silicon PostGIS error | No native arm64 image | `platform: linux/amd64` is already set |
| Old results after re-seed | What-if cache (10 min) | Restart the API |

---

## 19. Handover checklist

1. Add the new backend to the private repo; give access to `integration/models`.
2. Send the `Data` folder through a private channel, plus its SHA-256.
3. Tell them the export cutoff: `NEW_CENTER_LAST_MONTH=2026-10`.
4. Have them:
   - clone and switch to `integration/models`
   - create `.env` with `JWT_SECRET`, `SEED_DEMO_PASSWORD`, `TESDA_API_KEY`
   - `docker compose up -d db`
   - `docker compose --profile web up -d --build api web`
   - run seed, TESDA sync, data quality, simulation, forecast seed
   - place `Data` outside the repo, set `NEW_CENTER_DATA_PATH`, start the `new-center` profile
5. Verify health, forecast meta, new-center meta, and the sample prediction.
6. Confirm the data stays private and `8010` is not public.

Do **not** send `.env`, database dumps, `Forecast_Model/models`, or the raw export through Git.

---

## 20. Known limits and future work

- **Capacity slots are a demo placeholder** (20 per program per center per month). Real slots need
  a data source.
- **The monthly forecast artifact is not in every environment.** The committed 2026-10 seed serves
  the current month; future months need `Forecast_Model/models` from the data team.
- **The New Center Model needs the private export.** Options: share one service, commit a feature
  snapshot, or ask for a feature API.
- **No city-level New Center mapping yet.** `cityKey` is accepted but not sent to the model.
- **One API replica.** The scheduler and what-if baseline are process-local.
- **No user administration.** Real accounts come from T2MIS SSO; there is no self sign-up.
- **Travel is road/ferry time without traffic or ferry schedules.** The estimate is a fallback.
- **The basemap is a free public tile service.** Check its terms for production traffic.
- **Directions open Google Maps.** That is an external service.

---

## 21. Documentation map

| Need | Read |
|---|---|
| Run it locally, step by step | [GETTING_STARTED.md](../GETTING_STARTED.md) |
| Put it on a server | [HOSTING.md](../HOSTING.md) |
| Code conventions and commands | [CLAUDE.md](../CLAUDE.md) |
| Feature/API summary | [README.md](../README.md) |
| Frontend contract | [docs/FRONTEND_REQUIREMENTS.md](FRONTEND_REQUIREMENTS.md) |
| Forecast details | [docs/forecast/README.md](forecast/README.md) |
| New Center details | [docs/new-centers/README.md](new-centers/README.md) |
| Utilization details | [docs/utilization/README.md](utilization/README.md) |
| Handover runbook | [docs/handover/BACKEND_HANDOVER.md](handover/BACKEND_HANDOVER.md) |
| Forecast handover | [docs/handover/LIGHTGBM_FORECAST.md](handover/LIGHTGBM_FORECAST.md) |
| New Center handover | [docs/handover/NEW_CENTER_MODEL.md](handover/NEW_CENTER_MODEL.md) |
