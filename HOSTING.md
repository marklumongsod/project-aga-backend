# Hosting Project AGA

What it takes to run Project AGA on a server instead of a laptop, what was tested, and what still blocks a real rollout.

## The short version

- **It can be hosted.** Both images build and run: the API (426 MB) and the website (79 MB, nginx). Tested together through nginx: health checks, the public finder, sign-in, the dashboards, the SPA routes and the cache and security headers.
- **A single small server is enough** for the app itself (the database, API and website together use well under 1 GB of RAM). The optional OpenStreetMap routing servers are what need memory (about 3 GB for the two).
- **Do not go live with the demo setup.** There is no way yet to create real accounts (T2MIS sign-in is not connected), and the seed creates three demo accounts. See *Before going live*.

## What runs

| Part | What it is | Needed? | Memory (measured) |
| --- | --- | --- | --- |
| `db` | PostgreSQL 16 + PostGIS 3.4 | yes | about 0.3 GB, database about 0.14 GB |
| `api` | NestJS API (`aga-api` image) | yes | about 60 MB idle (more while a simulation runs) |
| `web` | nginx serving the built website and forwarding `/api` | yes | about 8 MB |
| `osrm` | OSRM, car profile at Philippine speed limits | optional | 1.5 GB |
| `osrm-foot` | OSRM with the foot profile | optional | 1.4 GB |

Routing is optional. Without it `TRAVEL_MODEL=estimate` still works, and with a precomputed matrix (`npm run travel:build`, stored in the database) the simulation needs no routing server at all. The routing servers are only used live for the finder's exact times, directions, a center's drive-time area and the what-if pin; if they are down those fall back to the stored matrix or the estimate and the API keeps answering.

Disk: about 4.6 GB for the OpenStreetMap extract and the two routing graphs (only if you host routing), plus the database.

## Deploy on one server with Docker Compose

Needs Docker, and both project folders next to each other (`project-aga-backend`, `project-aga-frontend`).

```bash
cd project-aga-backend
cp .env.example .env
# edit .env: a long random JWT_SECRET (openssl rand -hex 32), NODE_ENV=production if you like; see the checklist below

docker compose up -d db
docker compose --profile web up -d --build api web        # website on port 8080, API reachable only through it
docker compose exec api npm run db:seed:prod               # first time only: loads the data (see the demo-accounts note)
docker compose exec api npm run data:quality:prod -- --apply   # recovers the 38 centers a statistical check can save (see README, Data quality)
docker compose exec api npm run simulate:prod              # first results; the dashboards are empty until this has run
```

The API container applies database migrations every time it starts. Run the data-quality step after every `db:seed:prod` (a seed reloads the centers as the source has them), or the results will differ from other installs. Put TLS in front of port 8080 (your host's load balancer, Caddy, or nginx with a certificate); the app itself speaks plain http.

Optional routing: build the graphs once (`sh scripts/osrm-prepare.sh`), then `docker compose --profile routing up -d osrm osrm-foot`, `docker compose exec api npm run travel:build:prod`, and set `TRAVEL_MODEL=osrm` in `.env`. Details are in the README (*Real travel times*).

## Before going live

1. **Accounts.** `db:seed:prod` creates `co.planning@`, `ro.region6@` and `po.negrosoccidental@demo.aga.local` when `SEED_DEMO_PASSWORD` is set, with that password. For anything public, leave it empty (no demo accounts) or delete them afterwards. Real users come from **T2MIS single sign-on**: register AGA as a client on SSOPortal (authorization code + PKCE, redirect URI = the website's `/sso/callback`), then set `T2MIS_SSO_ISSUER`, `T2MIS_SSO_CLIENT_ID`, `T2MIS_SSO_CLIENT_SECRET` and `T2MIS_SSO_REDIRECT_URI`. The account is created at the first sign-in, and role and area come from the T2MIS claims through `T2MIS_SSO_ROLE_MAP` (README, *T2MIS single sign-on*). While the issuer is empty, SSO answers 501 and users have to be inserted by hand (a bcrypt password hash in the `users` table, with the role and region/province the account is limited to). To block someone, set `is_active = false`.
2. **Secrets.** A long random `JWT_SECRET` (the app refuses to start under 16 characters). Tokens last 8 hours and there is no refresh token. Keep `.env` out of git and images (the `.dockerignore` already does).
3. **HTTPS.** Required: the browser only allows "Use my location" on https, and sign-in sends a password.
4. **Proxy trust.** The compose file sets `TRUST_PROXY=1`. Behind a proxy every request otherwise appears to come from the proxy, so the **sign-in limit (10 a minute) and the public limit (60 a minute) would be shared by every user together**. This is covered by a test (`test/proxy.e2e-spec.ts`).
   Signed-in office users are limited per account, not per IP (`THROTTLE_OFFICE_LIMIT`, 600 a minute): an office shares one public IP and one dashboard page makes 8-10 calls, so a per-IP limit of 60 would have locked colleagues out of each other's work (`test/throttle.e2e-spec.ts`). The public finder and sign-in stay per IP (`THROTTLE_LIMIT`, `10` for sign-in). Set `TRUST_PROXY` to the number of proxies in front of the API (1 for nginx or one load balancer), and make sure the API is *only* reachable through them (the compose file binds its port to localhost for this reason); otherwise a client could fake the `X-Forwarded-For` header to dodge the limits.
5. **CORS.** The website calls `/api` on its own address, so CORS is not involved and `CORS_ORIGINS` can stay as is.
6. **Swagger** (`/docs`) is off when `NODE_ENV=production`. The API sends Helmet's security headers and nginx adds its own.
7. **Learner data.** No learner personal data is stored (RA 10173); `data/raw/` is never copied into an image. Don't add it to a server.

## Running it

- **Health:** `GET /api/v1/health` (checks the database) and `GET /healthz` on the website. Both images have Docker health checks.
- **Logs:** the API writes JSON logs to stdout (`docker compose logs -f api`). Tokens are not logged.
- **The monthly TESDA sync and the daily simulation run inside the API process** (sync 1:45 AM on the 1st, `TESDA_SYNC_CRON`; simulation 2:00 AM daily, `SIM_CRON`; Asia/Manila). Between syncs, new centers or graduates in TESDA's data show up only after the next sync or a manual `tesda:sync:prod`. **Run one API replica.** Two replicas would both run it, and the what-if keeps its baseline in each process's memory for 10 minutes, so a re-run on one wouldn't refresh the other.
- **History:** the latest run of each day is kept for 90 days and the last run of each quarter forever. Results live in `area_utilization` (about 1,700 rows per run) and `center_utilization` (about 5,000 rows per run).
- **Backups:** `docker compose exec -T db pg_dump -U aga -Fc aga > aga-$(date +%F).dump`. Everything that matters is in this one database (the recovery log, the travel matrix and the run history included). Restore with `pg_restore`.
- **Updating:** pull the code, `docker compose --profile web up -d --build api web`. Migrations run on start. After new centers or a new OpenStreetMap extract, run `travel:build:prod` and `simulate:prod`.
- **The routing data** (OpenStreetMap) is refreshed by hand: download a new extract, `sh scripts/osrm-prepare.sh`, restart the routing servers, rebuild the matrix.

## Known limits

- One API replica (above), and no user administration.
- The basemap comes from OpenFreeMap's free public tile service. That's fine for a demo; for a production service with real traffic, check its usage terms or host or buy tiles. If it is unreachable the maps still work without streets.
- Directions open Google Maps in a new tab, which is Google's service.
- Travel times don't include traffic or ferry timetables, and the slot counts are a flat placeholder (250 per center).

## What was checked for this guide

The API image and the website image build from a clean checkout, and the whole setup above (migrate, seed, data-quality, simulate, sign in, dashboard) was run in the production image on an empty database; the API starts as a non-root user, runs pending migrations, reports healthy, hides Swagger, rejects unauthenticated office routes (401) and serves the public finder; the website serves the app, falls back to `index.html` for in-app routes, caches built files for a year, sends the security headers on every response and forwards `/api`; a full sign-in and dashboard request works through it.

Problems found and fixed while checking: the lockfile was out of sync with npm 10 (the API image failed at `npm ci`), the shared rate limit behind a proxy, and nginx dropping its security headers on `/`.
