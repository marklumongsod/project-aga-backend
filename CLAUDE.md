# CLAUDE.md: Project AGA backend

Project AGA (Assessment Center Gap Analysis) is for TESDA in the Philippines. It simulates whether each assessment center has the capacity to absorb the training graduates who need a National Certificate assessment. It flags candidates with no center within 90 minutes or 50 km, colors every region, province and city by assessment desert level and candidate density, and lets offices drop a proposed center on the map to see the effect.

This repo is the **API only**. The frontend is a separate app; its spec is in `docs/FRONTEND_REQUIREMENTS.md`. Humans should start with `README.md`. This file is the working guide for Claude.

## Stack

- NestJS 11, TypeScript 5.9 (strict), Node 20 or newer (22 recommended)
- PostgreSQL 16 + PostGIS 3.4, accessed through TypeORM 0.3. Raw SQL is used where PostGIS is involved.
- Jest for unit tests (`src/**/*.spec.ts`) and e2e tests (`test/*.e2e-spec.ts`, these need a seeded database)
- Python ETL (`etl/build_seed.py`) only to rebuild the seed JSON from raw files. Not needed day to day.

## Commands

```bash
docker compose up -d db        # Postgres + PostGIS on :5432 (user/pass/db: aga)
npm ci
npm run db:setup               # migrate + seed (seed data is in database/seed-data/) + TESDA API sync + data-quality recovery
npm run tesda:sync             # centers, qualifications, upcoming graduates (students list) from the TESDA API (skipped if TESDA hasn't recalculated; -- --force)
npm run simulate               # first run; the dashboards return 404 until this runs
# optional real travel times (OSRM): see README "Real travel times"; docker compose --profile routing up -d osrm; npm run travel:build
npm run start:dev              # http://localhost:3000/api/v1 · Swagger at http://localhost:3000/docs

npm run lint                   # tsc --noEmit (type check; there is no ESLint)
npm test                       # unit tests: engine + rate bands
npm run test:e2e               # 25 e2e tests against the seeded DB (runs in band)
npm run build                  # → dist/
```

Before you say a change is done, run `npm run lint && npm test`, and also `npm run test:e2e` if you touched a controller, service, query or migration.

Database changes:

```bash
npx typeorm-ts-node-commonjs migration:generate src/database/migrations/<Name> -d src/database/data-source.ts
npm run db:migrate             # apply
npm run db:revert              # undo last
```

Always read a generated migration before keeping it. TypeORM tends to duplicate enum types and to use `uuid_generate_v4()`; this repo uses `gen_random_uuid()`. It also drops PostGIS GiST indexes it doesn't know about.

## Layout

```
src/
  main.ts                    prefix /api, URI versioning (v1 default), helmet, CORS allow-list, Swagger (not in prod)
  app.module.ts              config, TypeORM, throttler, schedule, pino, global guards
  config/env.validation.ts   every env var is validated at boot; add new ones here AND in .env.example
  common/
    auth.decorators.ts       @Public(), @Roles(...), @CurrentUser()
    guards.ts                global JwtAuthGuard (opt-out with @Public) + RolesGuard
    rate-band.ts             desert levels (DESERT_LEVELS), isoBand(), toEpoch()
    geo/haversine.ts
    database-exception.filter.ts
  auth/                      POST /auth/login, POST /auth/sso/t2mis (501 stub), GET /auth/me
  scope/area-scope.service.ts  THE place that decides which areas a user may see; use it, don't re-implement
  dashboard/                 /dashboard/overview | map | centers
  centers/                   /centers/:id and /centers/:id/reach
  simulation/
    engine/utilization-engine.ts   pure TS, no Nest or DB imports. Unit-tested. Keep it pure.
    travel/travel-time.model.ts    TravelTimeModel interface (from: TravelOrigin, to: TravelDest, km) + the estimate model (TRAVEL_TIME_MODEL token)
    travel/matrix-travel-time.model.ts  routed minutes from the travel_times matrix, estimate as fallback; withOverlay() for a what-if pin
    travel/osrm.client.ts          OSRM table client (chunks to 100 coordinates); travel/routing.service.ts = live calls, never throws
    travel/travel-matrix.service.ts  loads the matrix (TRAVEL_MODEL=osrm) and builds it from OSRM (`npm run travel:build`)
    demand.service.ts              candidates per city (BSRS; province totals split 20% evenly + 80% by upcoming TESDA graduates where a city has no figure, `demand-split.ts`)
    simulation.service.ts          runAll, persist, prune (rolling history), runFor (stored or one-off run), whatIf (cached baseline)
    simulation.scheduler.ts        daily run on SIM_CRON (Asia/Manila)
  public/                    /public/* learner finder + /geo/* (no auth, rate limited)
  health/                    /health (terminus + DB ping)
  database/
    data-source.ts           typeormOptions(); synchronize is ALWAYS false
    entities/                enums.ts has Role (CO|RO|PO), AreaLevel, RunStatus
    migrations/              schema changes only here
    seed.ts                  loads database/seed-data/*.json; upserts demo users if SEED_DEMO_PASSWORD is set
  cli/simulate.ts            `npm run simulate`
  cli/data-quality.ts        `npm run data:quality [-- --apply|--revert]`: what is excluded/filled in, and can it be saved (robust statistics)
  cli/build-travel-matrix.ts `npm run travel:build` (needs the OSRM server)
  cli/travel-spotcheck.ts    `npm run qa:travel`: 10 trips (stratified, fixed rule) with Google Maps links; `-- --check file.csv` scores your Google times against ours at ±20%
etl/                         Python: raw xlsx/csv/geojson → database/seed-data/*.json
data/raw/                    raw source files. Git-ignored and never committed (contains learner PII)
docs/                        FRONTEND_REQUIREMENTS.md + design-reference/ (approved UI screens as HTML)
```

## Domain rules you must keep

**Roles and scope.** There are exactly three office roles plus the public. `AreaScopeService` enforces scope for every dashboard, center and what-if call.

| Role | Home area | Can see | Can drop a what-if pin |
| --- | --- | --- | --- |
| CO (Central Office) | Philippines | everything | anywhere on land |
| RO (Regional Office) | own region (`regionPsgc`) | own region + its provinces | inside own region |
| PO (Provincial Office) | own province (`provincePsgc`) | own province + its cities | inside own province |
| Public (learner) | none, no login | `/public/*`, `/geo/*` only | not allowed |

The DB check constraint `CHK_users_scope` ties role to scope columns: CO has neither, RO has a region, PO has both.

**Reach and deserts** (implemented in `engine/utilization-engine.ts`; there is no capacity model):
- A center is **in reach** of a city when the **road and ferry travel time** to it is within the travel limit (90 minutes by default). There is **no straight-line distance cap**: distance never decides reach. `SIM_MAX_SPEED_KMH` (90; at Philippine speed limits the fastest average straight-line pace measured in the routed data is about 84) is used only to bound how far to look (`SimulationService.searchKm`, 135 km at 90 minutes) so nothing reachable is missed. The travel matrix (`npm run travel:build`) covers that radius, so rebuild it and re-run `npm run simulate` after changing the limit or the speed. A city with candidates and no center in reach is an assessment desert, and all its candidates are **flagged**. Slots are not counted: capacity was removed (migration `DropCapacity`), so there is no `slots`, `used`, `taken`, `ratio`, `centersFull` or congestion rate anywhere. Don't add capacity back without asking.
- The engine is deterministic with no randomness.
- **No utilization or service rate.** Both were removed: the API has no `rate`, `serviceRate`, `band` or rate `legend`. Areas are judged by `flaggedShare`, assessment deserts and density; the map views are deserts (default) and density.
- **Adjustable travel limit**: `?limitMinutes=` (10-180, that is up to 3 hours, default `SIM_LIMIT_MINUTES` = 90) on `/dashboard/overview|map|centers`, `/centers/:id` (+`/reach`, `/isochrone`) and the what-if body. A non-default value runs a one-off simulation (`SimulationService.runFor`), stored as an `adhoc` run, reused for 30 minutes, never part of history, trend or `/simulation/runs`. The daily stored run always uses the default. The 50 km limit is not adjustable.
- `flaggedShare` = flagged ÷ candidates. The frontend draws the legend from the API's `desertLegend` / `densityLegend` arrays, so change colors only in `DESERT_LEVELS` (`rate-band.ts`) and `common/density.ts`.
- **Snapping**: a pin dropped or dragged by hand is moved onto the nearest drivable road by `GET /simulation/snap` (OSRM `nearest`, within 5 km, only if the road point stays inside the area and the office's scope; otherwise it stays put).
- **Recommended sites** (`SimulationService.recommend`, `GET /simulation/recommendations`): candidate sites are the area's desert cities; the value of a site is the candidates in every desert it would bring within the travel and distance limits (the simulation's travel model, with the distance estimate for the new point); the best is picked, its deserts set aside, then the next (greedy, no overlap). A site reaches a desert when the routed road time from that desert to the site's pin is within the limit. The pin is a point inside the city moved to the nearest drivable road with OSRM `nearest` (only if within 3 km, still inside the area and the office's scope; otherwise it stays inside the city and `onRoad` is false). The what-if gives the exact result.
- **Predicted candidates** for a center = the candidates whose nearest reachable center it is.
- **Travel time** has two models, chosen by `TRAVEL_MODEL`. `estimate` (default): km × 1.35 ÷ 35 km/h, +90 min when origin and destination are on different `island_id`s (ferry). `osrm`: real road + ferry minutes from an OSRM server on the OSM Philippines extract, driven at Philippine speed limits (`scripts/osrm/car-ph.lua`: expressway 100, national roads 80, through streets 40, local 30, crowded 20; rebuild with `sh scripts/osrm-prepare.sh car`), precomputed per (city, center) pair into `travel_times` for the simulation and asked live for the finder, a center's reach and the what-if pin; pairs it can't route use the estimate. Never hard-code either formula outside `travel/`. The model is passed (origin city key, center id, km), not just km, so it can look up routes.
- **Assessment deserts** (team doc): a city with candidates and `nearestMinutes === null` (no center within the travel limit by road and ferry). Level 1-4 by candidates (1-200, 201-400, 401-600, 601+), `desertLevel()` in `rate-band.ts`, stored per area in `area_utilization`. The old dashboard "desert" (no center inside the city) is only a ranking tier now. **Density** = candidates per area in quintiles (`common/density.ts`), hotspot = the densest fifth; **ratio** = candidates / slots. `estimatedCandidates` marks city figures that are a split of a province total (BSRS covers ~20% of candidates): 20% evenly, 80% by the town's TESDA graduates (`splitByGraduates`).
- **Centers** come from the TESDA Assessor Coverage API (`src/tesda/`), synced into `assessment_centers` nightly before the simulation. Only `tesda_listed` centers are in the analysis; a center the API stops listing is marked unlisted, not deleted (old results point at it). The seed has no center list: only `center_corrections.json`, Team C's 134 hand-corrected positions (`geocode_override`, `water_fixed_geocode`), which win over the API's raw point. A fresh database has no centers until the sync runs (`db:setup` does it). The API rate-limits (429, no Retry-After): keep requests sequential and paced, and never call it per user request; read the synced tables.
- **Graduates** come from the API's students list (`GET /api/v1/students/all`, key with the students permission, ~97k rows, ~30 s per deep page). `TesdaClient.upcomingGraduates()` keeps only point, precision, qualification and finish month and sums them as pages arrive; the sync stores counts per town (`precision = 'city'`) or province only (`'province'`, `city_id` null) in `upcoming_graduates`. Never store a student row, barangay or school. A students failure keeps the old figures; the centers still update.
- **There is no next-quarter forecast.** The Insights tab, the `period` option, NEXT_QUARTER runs, `otherPeriod` and the next-quarter predicted candidates were removed (migration `DropNextQuarter`). `upcoming_graduates` keeps the finish month for a real forecast later (Team C's ML model); today it only weights the demand split and the "offer first" list. Don't re-add a forecast without asking.

**API conventions**
- Prefix `/api/v1`. Every route needs a JWT unless it is marked `@Public()`.
- Dates are **epoch seconds** in the database (`bigint` columns, `database/epoch.ts`) and in the API. Never add a `timestamp`/`date` column (a test fails); use `nowEpoch()` in code and `FLOOR(EXTRACT(EPOCH FROM now()))::bigint` in SQL (a bare `::bigint` rounds).
- Errors use the Nest default shape: `{ statusCode, message, error }`. Validation `message` is a string array.
- Inputs: every query and body goes through a class-validator DTO (whitelist + forbidNonWhitelisted). PSGC codes are 10-digit strings. City keys are strings: a PSGC code, or `D-...` for derived HUC boundaries.
- Swagger types come from the Nest CLI plugin. Response types must be **named classes**; inline object types crash Swagger at startup with circular-reference errors.
- `/public/*` must never return learner data, candidate counts, flagged counts or utilization. It returns centers, addresses, phones, qualifications and travel time only.

## Data and privacy (RA 10173)

- Never read or store learner PII: names, ULI, contact details, addresses, civil status. The T2MIS Student Profile and TSP sheets are intentionally ignored by the ETL.
- `data/raw/` stays out of git and out of any zip or Docker image.
- Seeded demo users are `*@demo.aga.local` with the password from `SEED_DEMO_PASSWORD`:
  - `co.planning@demo.aga.local` (CO)
  - `ro.region6@demo.aga.local` (RO, Region VI = `0600000000`)
  - `po.negrosoccidental@demo.aga.local` (PO, Negros Occidental = `0604500000`)

## Known gaps (don't "fix" these silently; ask first)

- T2MIS SSO is stubbed (`AuthService.loginWithT2mis` returns 501) until TESDA provides the issuer, client ID and JWKS.
- Bacolod, Ormoc, Isabela City and Cotabato City have no boundary, so they don't appear in place search. The other 15 HUCs are derived from holes in their province polygons (`derived_boundary = true`, no PSGC).
- Per-qualification views (`?qualification=` on `/dashboard/*` and `/simulation/recommendations`, options from `/dashboard/qualifications`) run a one-off simulation (`adhoc`, `qualification_key`, 30 minutes) on that qualification's upcoming graduates and only the centers accredited for it. It is a different population from the BSRS candidates of the default view; the planner's what-if is still all qualifications. The recommendation's "offer first" list, an estimate from upcoming graduates per province and qualification (`upcoming_graduates`, matched by name with `qualificationKey`). The province's mix is applied to the candidates a site would serve, so every site in one province shows the same ranking at a different scale. Which qualifications a center offers comes from the TESDA API for every listed center (`center_qualifications`). **Qualifications are identified by their TESDA API name only** ("Cookery II", shown as "Cookery NC II"): there is no T2MIS QualId or code anywhere (the `qualifications` table and `qualifications.json` were dropped, migration `DropT2misQualifications`), and the finder filters by `qualification` label. The public finder still returns `programData` coverage so the UI can explain empty results.
- There is no way to add real users yet (only the seeded demo accounts); T2MIS SSO is the planned route. Hosting notes: HOSTING.md.
- **Proposals** (`src/proposals/`, `POST/GET/DELETE /proposals`) store a what-if for a proposed center. The server re-runs the what-if on save and stores its own result (the client can't send numbers). Visible to the author, Central Office, and the RO/PO whose region/province the pin is in; deletable by the author or CO. There is still no review workflow: the planner's "Send to Regional Office" button is a stub.
- There is no Labor Market Information table: the source sheet was empty and the empty `labor_demand` table was dropped (with `center_programs`, `center_schedules`, `assessments`, `enrollments`, `bsrs_qualification_stats`, which nothing read).

## Gotchas

- `npm run simulate` must have run at least once, or `/dashboard/*` returns 404 with "No completed CURRENT simulation yet".
- What-if keeps the simulation inputs and baseline in memory for 10 minutes (`INPUT_TTL_MS`). The daily scheduler run refreshes them immediately. `npm run simulate` runs in a separate process, so after re-seeding or running the CLI, restart the server or wait 10 minutes. There is no HTTP route to start a run or list runs (removed: nothing in the frontend called them).
- On Apple Silicon, `postgis/postgis` has no arm64 image. Add `platform: linux/amd64` under the `db` service if Docker complains.
- `TRAVEL_MODEL=osrm` needs `travel_times` filled (`npm run travel:build`) or it logs a warning and uses the estimate. OSRM listens on host port 5001 (5000 clashes with macOS AirPlay). `data/osm/` (the ~600 MB extract and graph files) is git-ignored. Switching the model changes every flagged/utilization figure, so frontend tests read expected values from the API.
- Kill the server with `pgrep -f "^node dist/main.js" | xargs kill`. A bare `pkill -f "node dist/main.js"` also matches your own shell.

## Style

- Thin controllers, logic in services, pure functions where possible (engine, rate bands, travel model).
- Inject config through `ConfigService`; don't read `process.env` outside `env.validation.ts`, `data-source.ts` and the CLI scripts.
- Use parameterized SQL only (`$1`), never string-concatenated values.
- Coordinates are EPSG:4326 (lon, lat) in every geometry column; straight-line distances (`haversineKm`) are for search bounds and the walk check only, never for reach. Don't introduce another SRID.
- Results history is rolling: latest run per day for 90 days, per quarter forever, 5 newest (`prune()` in `simulation.service.ts`). Nothing reads the history over HTTP any more (`/dashboard/trend` and its stability check were removed with the frontend's history card); there is no ML model in this repo.
- Add a unit test for any engine or band change and an e2e test for any new endpoint, including a scope test (RO or PO hitting an area outside its scope → 403).
