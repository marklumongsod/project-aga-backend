# Project AGA - Backend API

AI-Based Assessment Center Gap Analysis (TESDA DISDAU Division).
NestJS 11 + PostgreSQL 16 / PostGIS 3 + TypeORM.

It serves:

- **CO / RO / PO dashboards**: the Overview, the 17 regions for the Philippines (Top 5), the provinces of a region and the cities of a province (Top 3), listing only areas with flagged candidates, a choropleth map, center cards and the 90-minute reach of a center.
- **Assessment deserts and flagged candidates**: which cities have no center in reach, run daily and on demand, plus a **drag-and-drop what-if** for a proposed center.
- **The public learner finder** (no sign-in): search a place or use your current location, filter by qualification and area, and get the nearest assessment centers by travel time.

> **New here?** Follow [GETTING_STARTED.md](GETTING_STARTED.md): the whole project (backend and frontend) step by step.

## Quick start (local)

```bash
cp .env.example .env              # set JWT_SECRET and SEED_DEMO_PASSWORD
docker compose up -d db           # PostgreSQL 16 + PostGIS
npm ci
npm run db:setup                  # migrations + seed (geography, BSRS, demo accounts) + TESDA API sync + data-quality recovery
npm run simulate                  # first simulation run (then daily at SIM_CRON)
npm run demo:utilization -- --quarter=2026-Q4   # optional: demo slots + per-qualification candidates for the capacity view
npm run start:dev                 # http://localhost:3000/api/v1, docs at http://localhost:3000/docs
```

Whole stack in containers, and what to check before putting it on a server: see [HOSTING.md](HOSTING.md).

Demo accounts (seed, password = `SEED_DEMO_PASSWORD`). Real accounts are provisioned from T2MIS; there is no sign-up.

| Email | Role | Scope |
| --- | --- | --- |
| co.planning@demo.aga.local | CO | All regions |
| ro.region6@demo.aga.local | RO | Region VI - Western Visayas |
| po.negrosoccidental@demo.aga.local | PO | Negros Occidental |

## Tests

```bash
npm test            # unit: simulation engine, legend bands
npm run test:e2e    # API against the seeded database (needs db:setup + simulate)
npm run lint        # type-check
```

## API (v1, prefix `/api/v1`)

| Method | Path | Who | What |
| --- | --- | --- | --- |
| POST | `/auth/login` | public | Normal sign-in → JWT |
| POST | `/auth/sso/t2mis` | public | TESDA SSO (T2MIS). Returns 501 until the T2MIS OIDC issuer is configured |
| GET | `/auth/me` | office | User and area scope |
| GET | `/dashboard/overview?level=&code=&limitMinutes=&qualification=&quarter=` | office | KPIs, Top 5 / Top 3, all child areas. Add `qualification` + `quarter` for capacity utilization |
| GET | `/dashboard/map` | office | GeoJSON choropleth of child areas (`desertLevel`, `densityBand`, `flaggedShare`; with `qualification`+`quarter`: `utilization`, `utilizationBand` and `utilizationLegend`) |
| GET | `/dashboard/centers` | office | Centers in the area: predicted candidates; with `qualification`+`quarter`: slots, assigned, utilization |
| GET | `/centers/:id` | office | Center card: qualifications, predicted candidates |
| GET | `/centers/:id/utilization?quarter=` | office | Capacity utilization per qualification the center offers |
| GET | `/centers/:id/reach` | office | Cities by travel time to the center (the fallback when there is no routing) |
| GET | `/centers/:id/isochrone` | office | True drive-time polygons (30 / 60 / 90 minutes) from OSRM road and ferry routing; 503 without routing |
| GET | `/simulation/snap?lat=&lon=&level=&code=` | office | Move a hand-placed pin onto the nearest road (within 5 km, inside the area), or leave it where it is |
| POST/GET/DELETE | `/proposals`, `/proposals/:id` | office | Save a what-if as a proposal (the server works out the result), list the ones you may see, open or delete one |
| GET | `/simulation/recommendations?level=&code=&limitMinutes=&count=` | office | Where to open a new center: up to 5 sites (default 3) in the area, best first. Each is a desert city with the pin moved onto the nearest road (OSRM), the candidates it serves, the deserts it closes, and the top 3 qualifications to offer (estimated from graduates per province and qualification) |
| POST | `/simulation/what-if` | office | Drag and drop a proposed center `{lat, lon}`: before/after for the user's area, nationally, and for the region and province where the pin lands (as far as the role may see), including assessment deserts closed |
| GET | `/public/places?q=` | public | Place search |
| GET | `/public/qualifications?q=` | public | Qualification filter |
| GET | `/public/centers/nearest?lat=&lon=` or `?cityKey=` `&qualificationId=&qualification=&regionPsgc=&provincePsgc=` | public | Nearest centers, travel time, `desert` flag |
| GET | `/public/route?lat=&lon=&centerId=` | public | Turn-by-turn road + ferry directions to one center: route line (GeoJSON), steps, `hasFerry`. Needs `TRAVEL_MODEL=osrm`; otherwise 503 |
| GET | `/geo/regions`, `/geo/regions/:psgc/provinces` | public | Regions and the provinces of a region, for the filters |
| GET | `/health` | public | Liveness + database |

Dates are **epoch seconds** everywhere: the database columns are `bigint` epoch seconds (UTC) and the API returns the same numbers (team convention; a test checks no `timestamp`/`date` column exists).

## Role scope

| Role | Lands on | Can open | Can drop a pin |
| --- | --- | --- | --- |
| CO | Philippines (Top 5 regions) | any region / province | anywhere on land |
| RO | own region (Top 3 provinces) | own region and its provinces | inside own region |
| PO | own province (Top 3 cities/municipalities) | own province | inside own province |
| Public | finder | centers, addresses, qualifications, travel time | - |

Public responses never include learner data, candidate counts or flagged counts.

## Reach, flagged candidates and deserts

Implemented in `src/simulation/engine/utilization-engine.ts` (pure, unit-tested). The regular run counts reach, not slots. A separate capacity view (`?qualification=&quarter=`) adds slots and utilization.

```
for each city (a group of candidates):
  list the centers it can reach:
    within the travel limit by road and ferry (90 minutes by default, per request with ?limitMinutes=)
    (no straight-line distance cap: reach is road travel time only)
  at least one center -> the candidates are served
  none                -> FLAG the candidates; the city is an assessment desert
flagged share = flagged / candidates
```

- Centers are listed **nearest-first** by travel time.
- **Predicted candidates** for a center = candidates whose nearest reachable center it is.
- A flagged candidate is therefore one with no center in reach, so flagged candidates equal the candidates in desert cities.

### Capacity utilization (per center and qualification, per quarter)

Add `?qualification=<key>&quarter=YYYY-Qn` to the dashboard calls. The capacity run assigns each qualification's candidates to the **nearest accredited center with an open slot within 90 minutes**; if that center is full, the candidate overflows to the next reachable center. Anyone left is flagged.

- Slots are stored monthly in `center_qualification_slots`: one row per center × qualification × month. A quarter is the sum of its three months.
- The local demo rule is **20 slots per program per center per month** (60 per quarter). Real NCR/TESDA data can replace it month by month.
- `utilization = candidates wanting the center ÷ quarter slots` (can exceed 100%; more candidates than capacity). At area level it is the area's candidates ÷ the area's slots.
- `assigned` = candidates actually placed in an open slot; `serviceRate = assigned ÷ candidates`.
- The center card endpoint `/centers/:id/utilization?quarter=2026-Q4` lists slots, candidates, assigned and utilization for every qualification the center offers.
- `utilizationLegend` is returned with the dashboard/map; bands go from green (low) to red (above 100%). Each band has a text label.
- Example:
  ```http
  GET /api/v1/dashboard/overview?qualification=cookery%20ii&quarter=2026-Q4
  GET /api/v1/centers/1974/utilization?quarter=2026-Q4
  ```
- Demo data:
  ```bash
  npm run demo:utilization -- --quarter=2026-Q4
  ```
  This inserts demo slots and demo per-qualification candidates (`source = 'demo'`) for the selected quarter. It does not touch TESDA rows, and it is safe to rerun. The regular reach simulation ignores demo graduate rows when splitting BSRS province totals.

### Assessment deserts, hotspots and density (team doc)

- **Assessment desert**: a city or municipality that has candidates and **no assessment center within the travel range** (the travel limit by road and ferry, exactly the simulation's reachability test). Computed in every run and stored per area. **Levels** by candidates: 1 = 1-200, 2 = 201-400, 3 = 401-600, 4 = 601 and up. Provinces and regions carry the number of desert cities inside and the highest level.
- **Density** = candidates in an area whether or not a center is nearby. The API classes each set of sibling areas into quintiles (`densityBand`, `densityLegend`); the densest fifth is the **hotspot**.
- **Estimated candidates.** BSRS has a count for only some cities (about 20% of the candidates). For the rest, the province total is split over its other cities: 20% evenly and 80% by each town's upcoming TESDA graduates (`upcoming_graduates`, from the API's students list, synced nightly), so the towns with more graduates get more and every town keeps a floor; an even split where a province has no graduate data. `estimatedCandidates` says how much of a city's figure is that filled-in share (province and national totals are measured). At city level, density is mostly this estimate, so read differences between cities of one province as rough.

### Data quality: can removed data be saved?

`npm run data:quality` reports what is excluded or filled in, and whether it could be kept (robust statistics: median and MAD, IQR fences):

- **Centers excluded on purpose** (hidden by TESDA, foreign, closed) stay out.
- **Centers excluded for data problems** (disputed coordinates, no city/province link) are tested: the coordinates must fall in the province the record names, and sit with the other centers of the same city (within median + 3 x MAD), or with the other excluded centers of a city that has no boundary (Bacolod). 38 of 41 pass: 25 in Zamboanga City, 12 in Bacolod City, 1 in Jala-Jala. `npm run data:quality -- --apply` recovers them (logged in `center_recovery_log`; `--revert` undoes it). `npm run db:setup` applies it, and a re-seed clears the log first. Effect on Negros Occidental: 62 to 74 centers, flagged 53.0% to 44.5%.
- **Candidates filled in by an even split** (a mean) are quantified, and provinces where the even share looks unlike the measured cities are flagged.

### Distances and coordinates

Coordinates are WGS84 longitude/latitude, **EPSG:4326**, in every PostGIS column (a test checks it). The km limit uses Haversine on the IUGG mean radius; against PostGIS's ellipsoidal distance on 20,000 real city-center pairs it differs by 0.26% on average and 0.55% at worst (0.27 km), and a test keeps it under 0.6%.

### Assumptions to replace with real data

| Input | Now | Replace with |
| --- | --- | --- |
| Candidates | BSRS completed per city. Province totals are split by TESDA graduates per town (20% evenly) where there is no city data; NCR districts are split over their cities | T2MIS enrollee-candidates per city |
| Travel time | `TRAVEL_MODEL=estimate`: straight line × 1.35 at 35 km/h, +90 min per sea crossing. `TRAVEL_MODEL=osrm`: real road + ferry times from OpenStreetMap (see *Real travel times* below) | Same, plus traffic and ferry schedules (OSRM knows neither) |
| Slots | Demo: 20 per program per center per month (= 60 per quarter), stored in `center_qualification_slots`; `npm run demo:utilization` fills it | TESDA/NCR slots per center, qualification and month, imported from the real capacity report |
| Next quarter | Not built: there is no forecast. The TESDA students sync keeps `upcoming_graduates` (per finish month) for it | Team C ML forecast (seasonal naive / SARIMA / gradient boosting with lags) |
| Per qualification | The capacity view uses upcoming TESDA graduates per town and qualification as a candidate proxy; the regular dashboard is all-qualification BSRS | T2MIS/BSRS candidate counts per city and qualification, then utilization per course with real data |

### Real travel times (OSRM)

Off by default. With `TRAVEL_MODEL=osrm` the simulation, a center's reach, the public finder and the what-if pin use road + ferry durations from an OSRM server built on the OpenStreetMap Philippines extract.

```bash
curl -L -o data/osm/philippines.osm.pbf https://download.geofabrik.de/asia/philippines-latest.osm.pbf   # ~600 MB
sh scripts/osrm-prepare.sh                       # one time, about a minute here (needs ~5 GB RAM)
docker compose --profile routing up -d osrm      # http://localhost:5001 (5000 is taken by AirPlay on macOS)
npm run db:migrate                               # creates travel_times
npm run travel:build                             # ~15 s: routes every city to every center within the search radius (135 km at 90 minutes, from SIM_MAX_SPEED_KMH)
# in .env: TRAVEL_MODEL=osrm  OSRM_URL=http://localhost:5001
npm run simulate                                 # re-run; the run records which model it used
```

- **How it's used.** The simulation reads a precomputed matrix (`travel_times`, one row per city-center pair within the search radius), so a run needs no network. Interactive calls (finder, reach, what-if pin) ask OSRM live for the exact point, in one batched call each.
- **Directions.** `GET /public/route` returns the route line and turn-by-turn steps (OSRM gives maneuvers, not text, so the sentences are built in `route-instructions.ts`). It only routes to an assessment center, never to an arbitrary point. A center within 500 m gets `mode: "walking"` instead: one straight leg (about 4.8 km/h, ×1.3 for paths) that needs no routing server. Beyond that it is `mode: "driving"`, and the response says how far the route's ends are from the real points (`snapped`) because OSRM starts and ends at the nearest road. The finder's "Get directions" link opens Google Maps (`directionsUrl`).
- **Fallbacks.** A pair OSRM can't route (about 0.01% here) and any call made while OSRM is down use the estimate; the API never errors because of routing. The response's `travelModel` says which was used.
- **Speeds.** The car graph uses Philippine speed limits (`scripts/osrm/car-ph.lua`): expressways 100 km/h, national roads (trunk, primary) 80 (RA 4136 open country), secondary and tertiary roads 40 (through streets), local streets 30, crowded and service roads 20; a posted limit tagged in OpenStreetMap wins. Change a speed there, then `sh scripts/osrm-prepare.sh car`, restart `osrm`, `npm run travel:build` and `npm run simulate`.
- **Limits.** Times assume driving at the limit and ignore traffic, ferry timetables and boarding waits, so real trips take longer. Where OSM has no ferry link between islands there is no route and the estimate (+90 min) applies.
- Rebuild the matrix (`npm run travel:build`) after loading a newer OSM extract or after the centers or cities change. The next daily run reloads it; a separate `npm run simulate` process always reads the table fresh (restart the server to pick it up at once).

## Data and privacy

`etl/build_seed.py` turns the raw files into `database/seed-data/*.json`; `npm run db:seed` loads them.

- **Geography**: PSGC 2023 (faeldon/philippines-json-maps, low resolution).
  - 15 highly urbanized cities missing from those files (Cebu City, Mandaue, Lapu-Lapu, Baguio, Iloilo City, Cagayan de Oro, General Santos, Zamboanga, …) are rebuilt from the holes in their province polygons, with `derived_boundary = true` and **no PSGC code** (not guessed). Bacolod, Ormoc, Isabela City and Cotabato City were not recovered.
  - `island_id` groups connected land; a trip between islands adds the ferry allowance.
- **Centers**: the **TESDA Assessor Coverage API** (`TESDA_API_URL`, Swagger at https://sap-sis.tesda.gov.ph/swagger/index.html) is the source. `npm run tesda:sync` (and the nightly job, just before the simulation) pulls every listed center (about 2,400), the qualifications each one can assess (`/api/v1/centers`, `/api/v1/qualifications`), and every upcoming graduate of the next 6 months (`/api/v1/students/all`, about 97,000 rows in pages of 2,000; the key needs the students permission). Every call needs `TESDA_API_KEY`. Only listed centers are analysed.
  - Upcoming graduates are summed as the pages arrive and stored only as counts per town (or per province, when the API knows only the province), qualification and finish month in `upcoming_graduates`. They weight the split of province candidate totals and give the recommendation's "offer first" qualifications. If the students pull fails (for example a key without the students permission), the previous figures are kept and the centers still update.
  - The seed still loads Team C's geocoded `assessment_center_points.geojson` (5,129) first: it supplies ids, Team C's hand-corrected positions (`geocode_override`, `water_fixed_geocode`; the API still has the raw point for those, so the corrected one is kept) and the rows older results point at. Centers the API no longer lists stay as `tesda_listed = false` and are out of the analysis.
  - The sync is skipped when TESDA has not recalculated since the last one (`GET /coverage/run`), so a quiet night costs one request; `npm run tesda:sync -- --force` pulls anyway. Requests go one at a time, 250 ms apart (the API rate-limits with 429). A pull that would drop more than half the listed centers, or more than half the stored graduates, is refused.
  - Each run is logged in `tesda_syncs`. API qualification names ("Cookery II") are matched to a T2MIS QualId where title + level match (about 80%).
  - After a sync with `TRAVEL_MODEL=osrm`, run `npm run travel:build` so new centers get routed times (they use the estimate until then).
- **Not stored**: names, ULI, contact details, civil status or addresses of learners. The T2MIS Student Profile and TSP sheets are never read. The students list has no names or ids; of each row only the point, qualification and finish month are read (barangay and school are dropped), and only sums are stored (Data Privacy Act of 2012, RA 10173).

To refresh the data: put the raw files in `data/raw/`, then run `pip install -r etl/requirements.txt`, `npm run etl` and `npm run db:seed`.

## Engineering notes

- **Request handling**: config validated at boot (`src/config/env.validation.ts`), DTO validation with whitelisting, a global JWT guard with `@Public()` opt-out, a roles guard and area scoping.
- **Security and operations**: Helmet, CORS allow-list, rate limiting (signed-in users per account, `THROTTLE_OFFICE_LIMIT`; the public finder per IP, `THROTTLE_LIMIT`; sign-in stricter; `TRUST_PROXY` makes it per real client behind a proxy), pino logs with secrets redacted, Swagger at `/docs` (outside production), terminus health check, graceful shutdown.
- **Database**: schema changes only through migrations (`synchronize: false`), PostGIS GiST indexes, a check constraint tying role to scope. Results are kept on a rolling basis: the latest run of each day for 90 days, the latest run of each quarter for good, and the 5 newest runs.
- **Versions**: pinned to NestJS 11 / TypeORM 0.3 / TypeScript 5.9. Newer majors exist (NestJS 12, TypeORM 1.x, TypeScript 7); upgrade in a separate change with the test suite. Prisma was considered, but its engine binaries could not be downloaded in the build environment.

## Open items

- **T2MIS SSO**: needs the issuer, client id and JWKS from T2MIS. The flow is stubbed in `AuthService.loginWithT2mis`.
- **Real accounts.** There is no way to add users except by hand in the database until T2MIS sign-in is connected (see HOSTING.md).
- **Isochrones** need `TRAVEL_MODEL=osrm`; without it the reach map shades whole cities by the estimated time.
- **Labor Market Information** data: the sheet in the dataset is empty, so there is no table for it (`labor_demand` was dropped; add it back with a migration when data arrives).
- **Per-qualification deserts**, once per-qualification candidate counts are available.
# project-aga-backend
