# Capacity Utilization (staging)

This document describes the capacity-based utilization view added to the `staging` branch.

Branch: `staging`  
Commit: `d523e49 [FEAT] Add capacity utilization view (staging)`

> Also included in `integration/models`, together with the monthly forecast and the New Center Model.

The regular reach-based dashboard is unchanged. Utilization appears only when both `qualification` and `quarter` are provided.

---

## 1. What it answers

> For a selected qualification and quarter, how much demand does each assessment center have compared with its slots?

For each center and qualification:

```text
demand       = candidates whose nearest center with an open slot is this center
assigned     = candidates actually placed in an open slot
slots        = quarter slots
utilization  = demand / slots
serviceRate  = assigned / demand
flagged      = candidates who could not get an open slot within 90 minutes
```

For each area:

```text
candidates  = all candidates in the area
assigned    = candidates assigned anywhere
slots       = slots of centers inside the area
utilization = candidates / slots
serviceRate = assigned / candidates
flagged     = candidates - assigned
```

`utilization` is a fraction:

- `0.5` = 50%
- `1.0` = 100%
- `2.0` = 200% (demand is twice the capacity)

Above 100% is not an error; it is the pressure/expansion signal.

---

## 2. Capacity rules

Candidates are assigned one qualification at a time:

1. Use centers accredited for the selected qualification.
2. Keep centers with an open slot.
3. Keep centers within **90 minutes**; there is no km limit.
4. Sort centers nearest-first by travel time, then center id.
5. The nearest open center receives the demand.
6. Fill its open slots.
7. Overflow to the next reachable open center.
8. Candidates left over are **flagged**.
9. Processing order is deterministic: city key, travel minutes, center id.

The engine is pure TypeScript:

```text
src/simulation/engine/capacity-engine.ts
src/simulation/engine/capacity-engine.spec.ts
```

---

## 3. Data model

### 3.1 Slots

Table: `center_qualification_slots`

| Column | Meaning |
| --- | --- |
| `id` | Primary key |
| `center_id` | Assessment center |
| `qualification_key` | Normalized TESDA qualification name |
| `qualification` | Display name, e.g. `Cookery II` |
| `month_start` | Epoch seconds, 00:00 Asia/Manila on the 1st |
| `slots` | Slots for that month |
| `source` | `demo`, `tesda`, `ncr` |
| `as_of` | Epoch seconds |

- Unique on `(center_id, qualification_key, month_start)`
- No `qualification_id` and no FK to a qualifications table
- Quarter slots = sum of the three months
- Demo rule: **20 slots per program per center per month**
- Quarter total: **60 slots per program per center**

### 3.2 Candidate source

Candidates come from `upcoming_graduates` (TESDA upcoming graduates). BSRS has been removed from staging.

Added column:

```text
upcoming_graduates.source = 'tesda' | 'demo'
```

Demo rows are marked `'demo'`.

### 3.3 Run and result fields

`simulation_runs`:

```text
quarter_start bigint
```

`area_utilization` and `center_utilization`:

```text
slots
assigned
utilization
service_rate
```

These are `NULL` on the regular all-qualification run.

### 3.4 Migration

```text
src/database/migrations/1792600000021-Utilization.ts
```

It runs after staging's `1792600000020-DropBsrsStats.ts` and is idempotent.

---

## 4. API

All endpoints require an office JWT.

### 4.1 Dashboard

```http
GET /api/v1/dashboard/overview?level=REGION&code=0600000000&qualification=cookery%20ii&quarter=2026-Q4
GET /api/v1/dashboard/map?level=REGION&code=0600000000&qualification=cookery%20ii&quarter=2026-Q4
GET /api/v1/dashboard/centers?level=REGION&code=0600000000&qualification=cookery%20ii&quarter=2026-Q4
```

Both `qualification` and `quarter` are required for utilization:

- Sending `quarter` without `qualification` → `400`
- Omitting both → the regular reach-based response with `null` capacity fields

Area/rows now include:

```text
slots
assigned
utilization
serviceRate
utilizationBand
```

`/dashboard/overview` also returns:

```text
quarter
qualification
utilizationLegend
```

`/dashboard/centers` adds:

```text
slots
assigned
utilization
serviceRate
```

### 4.2 Center breakdown

```http
GET /api/v1/centers/:id/utilization?quarter=2026-Q4
```

Returns every qualification the center offers:

```json
{
  "center": {
    "id": 6206,
    "name": "Example Training Center",
    "city": "City of Manila",
    "province": "...",
    "region": "..."
  },
  "quarter": "2026-Q4",
  "limitMinutes": 90,
  "qualifications": [
    {
      "key": "cookery ii",
      "qualification": "Cookery NC II",
      "slots": 60,
      "candidates": 9359,
      "assigned": 60,
      "utilization": 155.98,
      "serviceRate": 0.0064
    }
  ]
}
```

The first call may create one-off capacity runs per qualification. Later calls reuse them for up to 30 minutes.

### 4.3 Utilization legend

```text
band -1: No slots
band  0: 0-25%      low
band  1: 25-50%     moderate
band  2: 50-75%     high
band  3: 75-100%    near full
band  4: above 100% over capacity
```

The frontend should use `utilizationLegend`; do not hard-code colors.

---

## 5. Demo data

Command:

```bash
npm run demo:utilization -- --quarter=2026-Q4
```

What it creates:

- 20 slots per program per center per month
- 60 slots per program per center per quarter
- If staging has no real TESDA graduates:
  - 600 demo candidates per city, split over the top 3 center qualifications
  - 100 province-only graduates per province to exercise the estimated-candidate split
- All demo candidate rows use `source = 'demo'`
- Safe to rerun; it deletes only prior demo rows for the same quarter

Current local demo:

```text
demo slots:       44,775 monthly rows
demo candidates:   4,972 rows
quarter:           2026-Q4
```

### Rerun when

- after `db:seed`
- after a TESDA sync/monthly refresh
- after restoring or resetting the database
- when switching quarters

If real `upcoming_graduates` exist, the demo command only generates slots and leaves real candidates unchanged.

---

## 6. Local setup

```bash
cd project-aga-backend
git switch staging

docker compose up -d db
npm ci
npm run db:migrate
```

If the database has no centers or qualifications yet:

```bash
# Set TESDA_API_KEY in .env first
npm run tesda:sync
```

Or restore a demo database dump.

Then:

```bash
npm run demo:utilization -- --quarter=2026-Q4
npm run simulate
npm run start:dev
```

Health:

```bash
curl http://localhost:3000/api/v1/health
```

Swagger:

```text
http://localhost:3000/docs
```

Demo accounts:

```text
co.planning@demo.aga.local
ro.region6@demo.aga.local
po.negrosoccidental@demo.aga.local
```

Password is `SEED_DEMO_PASSWORD` in `.env`.

---

## 7. Verification

Current local checks:

```text
npm run lint         passed
npm test             174/174 passed
npm run build        passed
npm run test:e2e     146/146 passed
```

Useful database checks:

```bash
docker compose exec -T db psql -U aga -d aga -c "
  SELECT source, count(*) AS rows, sum(slots) AS slots
  FROM center_qualification_slots
  GROUP BY source;"
```

```bash
docker compose exec -T db psql -U aga -d aga -c "
  SELECT level, area_key, candidates, assigned, slots, utilization, service_rate
  FROM area_utilization
  WHERE run_id = (
    SELECT id FROM simulation_runs
    WHERE quarter_start IS NOT NULL
    ORDER BY finished_at DESC
    LIMIT 1
  )
  ORDER BY level, utilization DESC;"
```

---

## 8. Known limitations

- Slots are demo data until TESDA/NCR provide real monthly slots.
- Demo candidate counts are synthetic; real utilization needs real per-city × qualification assessee counts.
- Area `assigned` can exceed area `slots` because candidates may be assigned to centers outside the area.
- A center filled by overflow can show `candidates = 0` while `assigned > 0`.
- What-if / drag-and-drop is still reach-based, not capacity-aware.
- The monthly TESDA refresh can replace `upcoming_graduates`; rerun the demo afterward.
- `demo:utilization` must never run in production.
- Frontend screens are in the separate frontend repo.

---

## 9. Files changed

```text
src/database/migrations/1792600000021-Utilization.ts
src/database/entities/index.ts
src/database/entities/simulation.entity.ts
src/database/entities/t2mis.entity.ts
src/simulation/engine/capacity-engine.ts
src/simulation/engine/capacity-engine.spec.ts
src/simulation/demand.service.ts
src/simulation/simulation.service.ts
src/common/quarter.ts
src/common/quarter.spec.ts
src/common/utilization.ts
src/cli/demo-utilization.ts
src/dashboard/dashboard.dto.ts
src/dashboard/dashboard.service.ts
src/centers/centers.dto.ts
src/centers/centers.service.ts
src/centers/centers.controller.ts
test/app.e2e-spec.ts
package.json
CLAUDE.md
README.md
docs/FRONTEND_REQUIREMENTS.md
```
