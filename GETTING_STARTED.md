# Getting started: Project AGA, step by step

Project AGA is two apps that run side by side on your computer:

| App | Folder | What it is | Address |
| --- | --- | --- | --- |
| **Backend** (API) | `project-aga-backend` | NestJS + PostgreSQL/PostGIS. Runs the simulation and serves the data | http://localhost:3000 (Swagger: `/docs`) |
| **Frontend** (website) | `project-aga-frontend` | The office dashboard and the public finder | http://localhost:5173 |

Both folders sit next to each other (for example inside `Downloads/`). Every command below is for macOS Terminal.

---

## 0. One-time requirements

| Need | Check it | If missing |
| --- | --- | --- |
| **Docker Desktop**, running | `docker info` shows a "Server" section | Install Docker Desktop and open it |
| **Node.js 20 or newer** (24 recommended) | `node -v` | See *Node version* below |
| **nvm** (Node version manager) | `nvm --version` | https://github.com/nvm-sh/nvm |

### Node version (important)

If `node -v` says `v14` or any version below 20, the backend will not start. It fails with `SyntaxError: Unexpected token '??='`. Fix it in **every new terminal** before running any `npm` command:

```bash
nvm install 24      # only the first time
nvm use             # reads the .nvmrc file in the folder and switches to Node 24
```

To make Node 24 the default for all new terminals: `nvm alias default 24`.

---

## 1. First-time setup (do this once)

### 1.1 Backend

```bash
cd ~/Downloads/project-aga-backend
nvm use

# 1. settings
cp .env.example .env
#    then open .env and replace JWT_SECRET with a long random value, e.g. the output of:  openssl rand -hex 32

# 2. database (PostgreSQL + PostGIS in Docker; the first start downloads the image)
docker compose up -d db

# 3. dependencies
npm ci

# 4. create the tables and load the data (regions, provinces, cities, centers, demo accounts)
#    this also recovers 38 centers that the source data excluded but a statistical check can save (see README, Data quality)
npm run db:setup

# 5. run the first simulation (the dashboards show nothing until this has run once)
npm run simulate
```

You should see `seeded { regions: '17', provinces: '88', cities: '1628', centers: '5129', ... }` and `Applied: 38 centers recovered` after step 4, and two lines starting with `CURRENT` and `NEXT_QUARTER` after step 5.

### 1.2 Frontend

```bash
cd ~/Downloads/project-aga-frontend
nvm use
cp .env.example .env      # contains VITE_API_URL=/api/v1; no change needed
npm ci
```

---

## 2. Start the project (every time)

Use **three terminal tabs**.

**Tab 1: database** (skip if Docker already shows it running)
```bash
cd ~/Downloads/project-aga-backend
docker compose up -d db
```

**Tab 2: backend**
```bash
cd ~/Downloads/project-aga-backend
nvm use
npm run start:dev
```
Wait for `Nest application successfully started`. Check it: http://localhost:3000/api/v1/health should say `"status":"ok"`.

**Tab 3: frontend**
```bash
cd ~/Downloads/project-aga-frontend
nvm use
npm run dev
```
Open **http://localhost:5173**.

### Demo accounts

Sign in at http://localhost:5173/login. The password for all three is the `SEED_DEMO_PASSWORD` in your `.env` (default `ChangeMe!2026`).

| Email | Role | Sees |
| --- | --- | --- |
| `co.planning@demo.aga.local` | CO, Central Office | The whole country |
| `ro.region6@demo.aga.local` | RO, Regional Office | Region VI and its provinces |
| `po.negrosoccidental@demo.aga.local` | PO, Provincial Office | Negros Occidental and its cities |

The public finder at http://localhost:5173/ needs no account.

---

## 3. Stop the project

- Backend and frontend: press **Ctrl+C** in their tabs.
- Database: `docker compose stop` (keeps the data) in the backend folder.
- Everything including routing servers: `docker compose --profile routing stop`.

To wipe the database and start over (this **deletes all data**): `docker compose down -v`, then repeat step 1.1 from `docker compose up -d db`.

---

## 4. Optional: real road and ferry travel times (OpenStreetMap routing)

Without this, travel time is an estimate (straight-line distance, plus 90 minutes for a sea crossing). With it, the simulation, the finder, the center reach and the what-if pin use real road and ferry routes, and the finder can show turn-by-turn directions and walking routes.

It needs about 5 GB of free disk (the map plus two routing graphs) and a few minutes, once.

```bash
cd ~/Downloads/project-aga-backend
nvm use

# 1. download the Philippines map (about 600 MB)
mkdir -p data/osm
curl -L -o data/osm/philippines.osm.pbf https://download.geofabrik.de/asia/philippines-latest.osm.pbf

# 2. build the routing graphs (car and foot); about 2 minutes each, needs about 5 GB of free RAM
sh scripts/osrm-prepare.sh

# 3. start the two routing servers (ports 5001 and 5002)
docker compose --profile routing up -d osrm osrm-foot

# 4. precompute travel times for every city and center (about 15 seconds)
npm run travel:build
```

Then in `.env` set:

```
TRAVEL_MODEL=osrm
OSRM_URL=http://localhost:5001
OSRM_FOOT_URL=http://localhost:5002
```

Restart the backend, and run `npm run simulate` again so the results use the new times.

Later, to start with routing: `docker compose --profile routing up -d` instead of `docker compose up -d db`.

If the routing servers are off, the app keeps working with the estimate.

---

## 5. Optional: let other people open it (same Wi-Fi)

1. Find your address: `ipconfig getifaddr en0` (for example `10.100.14.75`).
2. In a fourth tab, run in the frontend folder:
   ```bash
   nvm use
   npm run dev:lan
   ```
3. Send them **https://YOUR-IP:5174** (note `https` and port `5174`).
4. The first time, their browser warns "connection is not private" because the certificate is self-signed. They choose *Advanced*, then *Proceed*.

Why `https`: browsers only allow "Use my location" on `localhost` or HTTPS.

Notes: it only works while your computer is on and on the same network. Anyone on that network can reach the demo accounts. Your address can change when you switch networks.

---

## 6. Run the tests

```bash
# backend (the database must be running and seeded)
cd ~/Downloads/project-aga-backend
npm run lint && npm test && npm run test:e2e

# frontend (the backend and `npm run dev` must be running)
cd ~/Downloads/project-aga-frontend
npm test                          # unit tests
npx playwright install chromium   # first time only
npx playwright test               # browser tests
```

---

## 7. Where things are

| Need | Where |
| --- | --- |
| API docs you can try in the browser | http://localhost:3000/docs |
| Backend overview, data sources, assumptions | `project-aga-backend/README.md` |
| Rules for working on the backend code | `project-aga-backend/CLAUDE.md` |
| What the website must do | `project-aga-backend/docs/FRONTEND_REQUIREMENTS.md` |
| Approved screen designs | `project-aga-backend/docs/design-reference/` |
| Frontend notes | `project-aga-frontend/README.md` |
| Putting it on a server | `project-aga-backend/HOSTING.md` |

Ports in use: 3000 backend, 5173 frontend, 5174 frontend for sharing, 5432 database, 5001 and 5002 routing servers.

---

## 8. Troubleshooting

| What you see | Why | Fix |
| --- | --- | --- |
| `SyntaxError: Unexpected token '??='` when starting the backend | Your terminal is using Node 14 | Run `nvm use` in that folder (see *Node version*) |
| Docker errors such as "Cannot connect to the Docker daemon" | Docker Desktop isn't running | Open Docker Desktop, wait until it says running, retry |
| `ports are not available ... 5000` | macOS AirPlay uses port 5000 | The project already uses 5001 for routing; nothing to change |
| "port already in use" on 3000 or 5173 | An earlier copy is still running | Find it with `lsof -i :3000`, stop it, or press Ctrl+C in its tab |
| Dashboards show "No simulation has run yet" (404) | `npm run simulate` hasn't run | Run `npm run simulate`, or sign in as CO and click **Run now** |
| Results look old after re-seeding or `npm run simulate` | The server keeps data in memory for 10 minutes | Restart the backend |
| "Too many attempts, try again in a minute" at sign-in | Sign-in is limited to 10 tries a minute | Wait a minute |
| `Invalid environment configuration` when the backend starts | A value in `.env` is missing or wrong | Compare `.env` with `.env.example`; `JWT_SECRET` must be at least 16 characters |
| `TRAVEL_MODEL=osrm but travel_times is empty` in the backend log | The travel-time table isn't built | Run `npm run travel:build` (section 4) |
| Map shows colors but no streets | The OpenStreetMap basemap couldn't load (offline) | Nothing to fix; it works without it. Reload when online |
| "Use my location" does nothing on a shared link | The page isn't on HTTPS | Use the `https://...:5174` address (section 5) |
| Apple Silicon: database image error | The PostGIS image has no native arm64 build | Already handled by `platform: linux/amd64` in `docker-compose.yml` |
