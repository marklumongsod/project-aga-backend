/**
 * End-to-end tests against a seeded PostgreSQL + PostGIS database.
 *   npm run db:setup && npm run simulate && npm run test:e2e
 * Needs SEED_DEMO_PASSWORD (demo office accounts) in the environment.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/main';
import { SimulationService } from '../src/simulation/simulation.service';
import area from '@turf/area';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point } from '@turf/helpers';
import { DataSource } from 'typeorm';
import { EPSG_WGS84, haversineKm } from '../src/common/geo/haversine';

const PW = process.env.SEED_DEMO_PASSWORD ?? '';
const R6 = '0600000000';
const NEGROS_OCC = '0604500000';

describe('Project AGA API (e2e)', () => {
  let app: INestApplication<App>;
  const token: Record<string, string> = {};
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.THROTTLE_LIMIT = '1000';
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
    for (const [k, email] of Object.entries({
      co: 'co.planning@demo.aga.local',
      ro: 'ro.region6@demo.aga.local',
      po: 'po.negrosoccidental@demo.aga.local',
    })) {
      const res = await api().post('/api/v1/auth/login').send({ email, password: PW }).expect(200);
      token[k] = res.body.accessToken;
    }
  });

  afterAll(() => app.close());

  const as = (who: string) => ({ Authorization: `Bearer ${token[who]}` });

  it('health is public', () =>
    api()
      .get('/api/v1/health')
      .expect(200)
      .expect((r) => expect(r.body.status).toBe('ok')));

  describe('epoch time in all date columns', () => {
    it('no column is a date or timestamp type: dates are bigint epoch seconds', async () => {
      const ds = app.get(DataSource);
      const bad: Array<{ table_name: string; column_name: string; data_type: string }> = await ds.query(
        `SELECT table_name, column_name, data_type FROM information_schema.columns
          WHERE table_schema = 'public' AND (data_type = 'date' OR data_type LIKE 'timestamp%' OR data_type LIKE 'time %')`,
      );
      expect(bad).toEqual([]);
      const dates: Array<{ data_type: string }> = await ds.query(
        `SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND column_name IN ('created_at', 'updated_at', 'started_at', 'finished_at', 'last_login_at', 'computed_at')`,
      );
      expect(dates.length).toBeGreaterThanOrEqual(8);
      for (const d of dates) expect(d.data_type).toBe('bigint');
    });

    it('the API returns epoch seconds (whole numbers around now), never date strings', async () => {
      const now = Math.floor(Date.now() / 1000);
      const ov = await api().get('/api/v1/dashboard/overview').set(as('co')).expect(200);
      const at = ov.body.run.finishedAt;
      expect(Number.isInteger(at)).toBe(true);
      expect(at).toBeGreaterThan(1_600_000_000);
      expect(at).toBeLessThanOrEqual(now + 5);
      const me = await api().get('/api/v1/auth/me').set(as('co')).expect(200);
      expect(me.body.lastLoginAt === null || Number.isInteger(me.body.lastLoginAt)).toBe(true);
      // no ISO date strings anywhere in the payload
      expect(JSON.stringify(ov.body)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      expect(JSON.stringify(me.body)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    });

    it('a sign-in stamps last_login_at with the current epoch second', async () => {
      const before = Math.floor(Date.now() / 1000);
      await api().post('/api/v1/auth/login').send({ email: 'co.planning@demo.aga.local', password: PW }).expect(200);
      const [u] = await app.get(DataSource).query(`SELECT last_login_at, updated_at FROM users WHERE email = 'co.planning@demo.aga.local'`);
      expect(Number(u.last_login_at)).toBeGreaterThanOrEqual(before - 1);
      expect(Number(u.last_login_at)).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);
      expect(Number(u.updated_at)).toBe(Number(u.last_login_at));
    });
  });

  describe('coordinates (EPSG:4326) and Haversine', () => {
    it('every PostGIS geometry column is WGS84 / EPSG:4326', async () => {
      const ds = app.get(DataSource);
      const cols: Array<{ f_table_name: string; f_geometry_column: string; srid: number }> = await ds.query(
        `SELECT f_table_name, f_geometry_column, srid FROM geometry_columns WHERE f_table_schema = 'public'`,
      );
      expect(cols.length).toBeGreaterThanOrEqual(5);
      for (const c of cols) expect({ column: `${c.f_table_name}.${c.f_geometry_column}`, srid: c.srid }).toEqual({ column: `${c.f_table_name}.${c.f_geometry_column}`, srid: EPSG_WGS84 });
    });

    it('Haversine agrees with PostGIS (ellipsoid) within 0.6% on real city-center pairs', async () => {
      const ds = app.get(DataSource);
      const rows: Array<{ la1: number; lo1: number; la2: number; lo2: number; km: number }> = await ds.query(
        `SELECT ci.lat AS la1, ci.lon AS lo1, c.lat AS la2, c.lon AS lo2,
                ST_Distance(ST_SetSRID(ST_MakePoint(ci.lon, ci.lat), 4326)::geography,
                            ST_SetSRID(ST_MakePoint(c.lon, c.lat), 4326)::geography) / 1000 AS km
           FROM travel_times t JOIN cities ci ON ci.key = t.city_key JOIN assessment_centers c ON c.id = t.center_id
          WHERE ci.lat <> c.lat OR ci.lon <> c.lon
          ORDER BY t.city_key, t.center_id LIMIT 3000`,
      );
      expect(rows.length).toBeGreaterThan(100);
      let worst = 0;
      for (const r of rows) worst = Math.max(worst, Math.abs(haversineKm(r.la1, r.lo1, r.la2, r.lo2) - r.km) / r.km);
      expect(worst).toBeLessThan(0.006);
    });
  });

  describe('rolling history retention', () => {
    const TAG = 'e2e-fixture';
    const DAY = 86400;
    let ds: DataSource;
    const ids: Record<string, string> = {};

    /** A past run, `daysAgo` days back at the given Manila hour, copying the latest run's rows
     *  for the national / Region VI / Negros Occidental areas with `shareDelta` added to the flagged share. */
    async function fixture(name: string, daysAgo: number, hourManila: number, shareDelta: number) {
      const [latest] = await ds.query(`SELECT id FROM simulation_runs WHERE status = 'COMPLETED' AND NOT adhoc AND triggered_by <> $1 ORDER BY finished_at DESC LIMIT 1`, [TAG]);
      const [day] = await ds.query(`SELECT (EXTRACT(EPOCH FROM date_trunc('day', now() AT TIME ZONE 'Asia/Manila') AT TIME ZONE 'Asia/Manila'))::bigint AS t`);
      const startedAt = Number(day.t) - daysAgo * DAY + hourManila * 3600;
      const [run] = await ds.query(
        `INSERT INTO simulation_runs (status, limit_minutes, travel_model, summary, triggered_by, started_at, finished_at)
         SELECT 'COMPLETED', limit_minutes, travel_model, summary, $2::varchar, $3::bigint, $3::bigint + 5 FROM simulation_runs WHERE id = $1 RETURNING id`,
        [latest.id, TAG, startedAt],
      );
      await ds.query(
        `INSERT INTO area_utilization (run_id, level, area_key, parent_key, candidates, flagged, centers, flagged_share)
         SELECT $2::uuid, level, area_key, parent_key, candidates, flagged, centers, flagged_share + $3::float8
           FROM area_utilization WHERE run_id = $1 AND (level = 'NATIONAL' OR (level = 'REGION' AND area_key = $4) OR (level = 'PROVINCE' AND area_key = $5))`,
        [latest.id, run.id, shareDelta, R6, NEGROS_OCC],
      );
      ids[name] = run.id;
      return Number(startedAt);
    }

    beforeAll(async () => {
      ds = app.get(DataSource);
      await ds.query(`DELETE FROM simulation_runs WHERE triggered_by = $1`, [TAG]);
      // eight days of history: steady for four days, then a jump (as if new data had been loaded), then steady again
      const offsets = [0, 0.001, -0.001, 0.0005, 0.12, 0.121, 0.12, 0.119];
      for (const [i, off] of offsets.entries()) await fixture(`d${8 - i}`, 8 - i, 10, off);
      // two more runs on the same day as d3: only the latest of a day should survive the clean-up
      await fixture('d3-early', 3, 9, 0.0005);
      await fixture('d3-late', 3, 18, 0.0005);
      // the 5 newest runs of any kind are always kept (prune), so fill those slots with today's runs: the retention
      // check below must not depend on how many real runs happen to be in the database
      for (let h = 0; h < 5; h++) await fixture(`filler${h}`, 0, h, 0);
      // old history: two runs on the same day 200 days ago (the later one is the last of its quarter)
      await fixture('old-early', 200, 8, 0);
      await fixture('old-late', 200, 20, 0);
    });

    afterAll(async () => {
      await ds.query(`DELETE FROM simulation_runs WHERE triggered_by = $1`, [TAG]);
    });

    it('retention keeps the latest run of each day for 90 days and of each quarter for good, and drops the rest', async () => {
      await app.get(SimulationService)['prune']();
      const left: Array<{ id: string }> = await ds.query(`SELECT id FROM simulation_runs WHERE triggered_by = $1`, [TAG]);
      const have = new Set(left.map((r) => r.id));
      expect(have.has(ids['d3-late']!)).toBe(true);
      expect(have.has(ids['d3-early']!)).toBe(false); // an earlier run of the same day
      expect(have.has(ids['d3']!)).toBe(false); // the 10:00 one is earlier than 18:00 too
      expect(have.has(ids['old-late']!)).toBe(true); // last run of its quarter: kept past 90 days
      expect(have.has(ids['old-early']!)).toBe(false);
      for (const d of ['d8', 'd7', 'd6', 'd5', 'd4', 'd2', 'd1']) expect(have.has(ids[d]!)).toBe(true); // one per day: all kept
    });
  });

  describe('totals reconcile across levels', () => {
    type Area = { candidates: number; flagged: number; centers: number; code: string };
    const overview = async (q = '') => (await api().get(`/api/v1/dashboard/overview${q}`).set(as('co')).expect(200)).body as { area: Area; rows: Area[] };
    const sum = (rows: Area[], k: 'candidates' | 'flagged' | 'centers') => rows.reduce((n, r) => n + r[k], 0);

    it('national = the sum of its regions, and each region = the sum of its provinces', async () => {
      const nat = await overview();
      expect(nat.area.candidates).toBeGreaterThan(0);
      for (const k of ['candidates', 'flagged', 'centers'] as const) expect(sum(nat.rows, k)).toBe(nat.area[k]);
      const regions = (await api().get('/api/v1/geo/regions').expect(200)).body as Array<{ psgc: string }>;
      let cand = 0;
      let flagged = 0;
      for (const r of regions) {
        const ov = await overview(`?level=REGION&code=${r.psgc}`);
        cand += ov.area.candidates;
        flagged += ov.area.flagged;
        for (const k of ['candidates', 'flagged', 'centers'] as const) expect(sum(ov.rows, k)).toBe(ov.area[k]); // region = its provinces
      }
      expect(cand).toBe(nat.area.candidates);
      expect(flagged).toBe(nat.area.flagged);
    });

    it('every province: candidates and flagged are the sum of its cities; centers differ only by centers with no city', async () => {
      const ds = app.get(DataSource);
      const nat = await overview();
      const provinces: Area[] = [];
      for (const r of nat.rows) provinces.push(...(await overview(`?level=REGION&code=${r.code}`)).rows);
      const noCity: Array<{ province_psgc: string; n: number }> = await ds.query(
        `SELECT province_psgc, count(*)::int AS n FROM assessment_centers WHERE include_in_analysis AND city_id IS NULL GROUP BY 1`,
      );
      const withoutCity = new Map(noCity.map((r) => [r.province_psgc, r.n]));
      for (const p of provinces) {
        const ov = await overview(`?level=PROVINCE&code=${p.code}`);
        expect(sum(ov.rows, 'candidates')).toBe(ov.area.candidates);
        expect(sum(ov.rows, 'flagged')).toBe(ov.area.flagged);
        expect(ov.area.centers - sum(ov.rows, 'centers')).toBe(withoutCity.get(p.code) ?? 0);
      }
    });

    it('the flagged candidates are never more than the candidates, at every level', async () => {
      const nat = await overview();
      for (const r of [nat.area, ...nat.rows]) expect(r.flagged).toBeLessThanOrEqual(r.candidates);
    });
  });

  describe('proposals (saved what-ifs)', () => {
    const TAG = 'e2e-proposal';
    const SIPALAY = { lat: 9.752, lon: 122.405 }; // Negros Occidental, Region VI
    const CEBU = { lat: 10.3157, lon: 123.8854 }; // Region VII
    const post = (who: 'co' | 'ro' | 'po', body: object) => api().post('/api/v1/proposals').set(as(who)).send({ name: TAG, ...body });
    const list = async (who: 'co' | 'ro' | 'po') => (await api().get('/api/v1/proposals').set(as(who)).expect(200)).body as Array<{ id: string; name: string; mine: boolean }>;
    const mine = async (who: 'co' | 'ro' | 'po') => (await list(who)).filter((p) => p.name === TAG);
    const clean = () => app.get(DataSource).query(`DELETE FROM proposals WHERE name = $1`, [TAG]);
    beforeEach(clean);
    afterAll(clean);

    it('saves what the server worked out, not what the client says', async () => {
      const r = await post('po', { ...SIPALAY, result: { newlyServed: 999999 }, snapshot: 1 }).expect(400); // unknown fields are refused
      expect(JSON.stringify(r.body.message)).toContain('should not exist');
      const ok = await post('po', SIPALAY).expect(201);
      expect(ok.body).toMatchObject({ name: TAG, cityName: 'City of Sipalay', areaCode: NEGROS_OCC, status: 'SAVED', mine: true });
      expect(ok.body.result.newlyServed).toBeGreaterThan(0);
      expect(ok.body.newlyServed).toBe(ok.body.result.newlyServed);
      expect(ok.body.desertCitiesClosed).toBe(ok.body.result.area.desertCitiesBefore - ok.body.result.area.desertCitiesAfter);
      expect(ok.body.createdAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
      for (const k of ['slots', 'slotsPerQuarter']) expect(ok.body.result).not.toHaveProperty(k);
    });

    it('uses the same checks as the what-if: a pin outside the office area or the chosen area is refused', async () => {
      await post('po', CEBU).expect(400);
      await post('po', { ...SIPALAY, level: 'PROVINCE', code: '0305400000' }).expect(403);
      await post('co', { ...CEBU, level: 'PROVINCE', code: NEGROS_OCC }).expect(400);
      expect(await mine('po')).toHaveLength(0);
    });

    it('is visible to its author, to Central Office and to the regional office of the area, not to others', async () => {
      const saved = await post('po', SIPALAY).expect(201);
      for (const who of ['po', 'ro', 'co'] as const) expect((await mine(who)).map((p) => p.id)).toContain(saved.body.id);
      expect((await mine('po'))[0]!.mine).toBe(true);
      expect((await mine('ro'))[0]!.mine).toBe(false);
      const elsewhere = await post('co', CEBU).expect(201); // Region VII: not the RO's region, not the PO's province
      expect((await mine('co')).map((p) => p.id)).toContain(elsewhere.body.id);
      expect((await mine('ro')).map((p) => p.id)).not.toContain(elsewhere.body.id);
      expect((await mine('po')).map((p) => p.id)).not.toContain(elsewhere.body.id);
      await api().get(`/api/v1/proposals/${elsewhere.body.id}`).set(as('po')).expect(404);
      await api().get(`/api/v1/proposals/${elsewhere.body.id}`).set(as('ro')).expect(404);
      const one = await api().get(`/api/v1/proposals/${saved.body.id}`).set(as('ro')).expect(200);
      expect(one.body.result.pin.cityName).toBe('City of Sipalay');
    });

    it('can be deleted by its author or by Central Office, not by someone who can only see it', async () => {
      const a = await post('po', SIPALAY).expect(201);
      await api().delete(`/api/v1/proposals/${a.body.id}`).set(as('ro')).expect(403);
      await api().delete(`/api/v1/proposals/${a.body.id}`).set(as('po')).expect(204);
      await api().get(`/api/v1/proposals/${a.body.id}`).set(as('po')).expect(404);
      const b = await post('po', SIPALAY).expect(201);
      await api().delete(`/api/v1/proposals/${b.body.id}`).set(as('co')).expect(204);
      expect(await mine('po')).toHaveLength(0);
    });

    it('needs a sign-in, and a real id', async () => {
      await api().get('/api/v1/proposals').expect(401);
      await api().post('/api/v1/proposals').send(SIPALAY).expect(401);
      await api().get('/api/v1/proposals/not-an-id').set(as('co')).expect(400);
      await api().get('/api/v1/proposals/00000000-0000-4000-8000-000000000000').set(as('co')).expect(404);
    });
  });

  describe('auth', () => {
    it('rejects a wrong password with a generic message', () =>
      api()
        .post('/api/v1/auth/login')
        .send({ email: 'co.planning@demo.aga.local', password: 'nope' })
        .expect(401)
        .expect((r) => expect(r.body.message).toBe('Email or password is incorrect')));

    it('rejects unknown fields (no mass assignment)', () =>
      api().post('/api/v1/auth/login').send({ email: 'a@b.co', password: 'x', role: 'CO' }).expect(400));

    it('T2MIS SSO answers 501 until configured', () =>
      api().post('/api/v1/auth/sso/t2mis').send({ idToken: 'x' }).expect(501));

    it('returns the signed-in user and scope', () =>
      api()
        .get('/api/v1/auth/me')
        .set(as('po'))
        .expect(200)
        .expect((r) =>
          expect(r.body).toMatchObject({ role: 'PO', regionPsgc: R6, provincePsgc: NEGROS_OCC }),
        ));

    it('tells the app when the user signed in (epoch seconds), for the landing view', async () => {
      const before = Math.floor(Date.now() / 1000);
      const login = await api().post('/api/v1/auth/login').send({ email: 'ro.region6@demo.aga.local', password: PW }).expect(200);
      expect(login.body.user.lastLoginAt).toBeGreaterThanOrEqual(before - 1);
      expect(Number.isInteger(login.body.user.lastLoginAt)).toBe(true);
      const me = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${login.body.accessToken}`).expect(200);
      expect(me.body.lastLoginAt).toBe(login.body.user.lastLoginAt);
    });

    it('office routes need a token', () => api().get('/api/v1/dashboard/overview').expect(401));
  });

  describe('dashboards (Overview, Top 5 / Top 3, role scope)', () => {
    it('CO lands on the Philippines with a Top 5 of provinces', () =>
      api()
        .get('/api/v1/dashboard/overview')
        .set(as('co'))
        .expect(200)
        .expect((r) => {
          expect(r.body.area).toMatchObject({ level: 'NATIONAL', code: 'PH' });
          expect(r.body.childLevel).toBe('REGION');
          expect(r.body.top).toHaveLength(5);
          // the Philippines lists its regions (top, table and map)
          for (const t of r.body.top) expect(t.level).toBe('REGION');
          expect(r.body.rows).toHaveLength(17);
          expect(r.body.rows.every((x: { level: string }) => x.level === 'REGION')).toBe(true);
          expect(r.body.area.candidates).toBeGreaterThan(1_000_000);
          for (const k of ['period', 'otherPeriod']) expect(r.body).not.toHaveProperty(k); // no next-quarter view
        }));

    it('the top list holds only areas with flagged candidates, as many as there are (up to the limit)', async () => {
      for (const [who, q, max] of [
        ['co', '', 5],
        ['co', '?level=REGION&code=0400000000', 3], // CALABARZON: Quezon flagged, Batangas and Cavite not
        ['ro', '', 3],
        ['po', '', 3],
      ] as const) {
        const ov = (await api().get(`/api/v1/dashboard/overview${q}`).set(as(who)).expect(200)).body;
        const withFlagged = ov.rows.filter((r: { flagged: number }) => r.flagged > 0);
        expect(ov.top.every((t: { flagged: number }) => t.flagged > 0)).toBe(true);
        expect(ov.top).toHaveLength(Math.min(max, withFlagged.length));
      }
    });

    it('has no next-quarter (Insights) view: the period option is refused', () =>
      api().get('/api/v1/dashboard/overview?period=NEXT_QUARTER').set(as('co')).expect(400));

    it('RO lands on their region with a Top 3 of provinces', () =>
      api()
        .get('/api/v1/dashboard/overview')
        .set(as('ro'))
        .expect(200)
        .expect((r) => {
          expect(r.body.area).toMatchObject({ level: 'REGION', code: R6 });
          expect(r.body.top.length).toBeLessThanOrEqual(3);
          expect(r.body.rows.every((x: { level: string }) => x.level === 'PROVINCE')).toBe(true);
        }));

    it('PO lands on their province with a Top 3 of cities and municipalities', () =>
      api()
        .get('/api/v1/dashboard/overview')
        .set(as('po'))
        .expect(200)
        .expect((r) => {
          expect(r.body.area).toMatchObject({ level: 'PROVINCE', code: NEGROS_OCC });
          expect(r.body.childLevel).toBe('CITY');
          expect(r.body.top.length).toBeLessThanOrEqual(3);
        }));

    it('RO cannot open the national view or another region', async () => {
      await api().get('/api/v1/dashboard/overview?level=NATIONAL').set(as('ro')).expect(403);
      await api().get('/api/v1/dashboard/overview?level=REGION&code=0700000000').set(as('ro')).expect(403);
    });

    it('PO cannot open a province outside theirs', () =>
      api().get('/api/v1/dashboard/overview?level=PROVINCE&code=0305400000').set(as('po')).expect(403));

    it('tells each area what it sits in, so the pickers can show the region of a province', async () => {
      const po = await api().get('/api/v1/dashboard/overview').set(as('po')).expect(200);
      expect(po.body.area).toMatchObject({ level: 'PROVINCE', code: NEGROS_OCC, parentCode: R6 });
      expect(po.body.rows.every((r: { parentCode: string }) => r.parentCode === NEGROS_OCC)).toBe(true);
      const co = await api().get('/api/v1/dashboard/overview').set(as('co')).expect(200);
      expect(co.body.area.parentCode).toBeNull();
      expect(co.body.rows.every((r: { parentCode: string }) => r.parentCode === 'PH')).toBe(true); // the Philippines lists regions
      const r6 = await api().get(`/api/v1/dashboard/overview?level=REGION&code=${R6}`).set(as('co')).expect(200);
      const negros = r6.body.rows.find((r: { code: string }) => r.code === NEGROS_OCC);
      expect(negros.parentCode).toBe(R6);
    });

    it('reports a reach-based service rate, never a capacity rate', async () => {
      const ov = await api().get('/api/v1/dashboard/overview').set(as('co')).expect(200);
      for (const o of [ov.body.area, ...ov.body.rows]) {
        expect(o.served).toBe(o.candidates - o.flagged);
        if (o.candidates > 0) {
          expect(o.serviceRate).toBeGreaterThanOrEqual(0);
          expect(o.serviceRate).toBeLessThanOrEqual(1);
          // served / candidates is the same figure as 1 - flaggedShare, by definition
          expect(o.serviceRate).toBeCloseTo(1 - o.flaggedShare, 10);
        } else {
          expect(o.serviceRate).toBeNull();
        }
        for (const k of ['rate', 'band', 'utilization', 'slots', 'slotsPerQuarter']) expect(o).not.toHaveProperty(k);
      }
      expect(ov.body).not.toHaveProperty('legend');
    });

    describe('adjustable travel limit (?limitMinutes=)', () => {
      const flagged = async (q: string) =>
        (await api().get(`/api/v1/dashboard/overview${q}`).set(as('co')).expect(200)).body.area.flagged as number;

      it('a shorter limit flags more candidates, a longer one fewer; the default is the stored run', async () => {
        const base = await flagged('');
        expect(await flagged('?limitMinutes=90')).toBe(base);
        expect(await flagged('?limitMinutes=30')).toBeGreaterThanOrEqual(base);
        expect(await flagged('?limitMinutes=180')).toBeLessThanOrEqual(base);
      });

      it('the run reports the limit it used, and never enters the history', async () => {
        const ov = await api().get('/api/v1/dashboard/overview?limitMinutes=45').set(as('co')).expect(200);
        expect(ov.body.run.assumptions.limitMinutes).toBe(45);
        const kept: Array<{ limit_minutes: number }> = await app.get(DataSource).query(`SELECT limit_minutes FROM simulation_runs WHERE NOT adhoc`);
        expect(kept.every((r) => r.limit_minutes === 90)).toBe(true);
      });

      it('keeps role scope with a custom limit', async () => {
        await api().get('/api/v1/dashboard/overview?level=NATIONAL&limitMinutes=45').set(as('ro')).expect(403);
        await api().get('/api/v1/dashboard/map?limitMinutes=45').set(as('po')).expect(200);
      });

      it('accepts the largest limit, 3 hours', () => api().get('/api/v1/dashboard/overview?limitMinutes=180').set(as('co')).expect(200));

      it.each(['5', '181', '300', 'abc', '45.5'])('rejects limitMinutes=%s', (v) =>
        api().get(`/api/v1/dashboard/overview?limitMinutes=${v}`).set(as('co')).expect(400));

      it('what-if and the reach map accept it too', async () => {
        const w = await api()
          .post('/api/v1/simulation/what-if')
          .set(as('co'))
          .send({ lat: 10.6765, lon: 122.9509, limitMinutes: 45 })
          .expect(200);
        expect(w.body.limitMinutes).toBe(45);
        expect(w.body.area).not.toHaveProperty('serviceRateAfter');
        expect(w.body).not.toHaveProperty('pinUtilization');
      });
    });

    it('map returns a GeoJSON choropleth of the child areas', () =>
      api()
        .get('/api/v1/dashboard/map')
        .set(as('ro'))
        .expect(200)
        .expect((r) => {
          expect(r.body.type).toBe('FeatureCollection');
          expect(r.body.features.length).toBe(6);
          expect(r.body.features[0].properties).not.toHaveProperty('band');
        }));

    describe('assessment deserts and density (team doc)', () => {
      it('lists assessment deserts by level, consistent with the cities in them', async () => {
        const ov = await api().get('/api/v1/dashboard/overview').set(as('co')).expect(200);
        const d = ov.body.deserts;
        expect(d.byLevel.map((l: { level: number }) => l.level)).toEqual([1, 2, 3, 4]);
        expect(d.cities).toBe(d.byLevel.reduce((n: number, l: { cities: number }) => n + l.cities, 0));
        expect(d.candidates).toBe(d.byLevel.reduce((n: number, l: { candidates: number }) => n + l.candidates, 0));
        expect(d.cities).toBeGreaterThan(0); // the seeded country has islands no center can reach
        expect(ov.body.area.desertCities).toBe(d.cities);
        expect(ov.body.desertLegend.map((l: { band: number }) => l.band)).toEqual([0, 1, 2, 3, 4]);
        expect(ov.body.desertLegend[4].label).toContain('more than 60');
      });

      it('a province lists its own desert cities with levels that follow the candidate counts', async () => {
        // find a province that has a desert city, then check the city rows
        const co = await api().get('/api/v1/dashboard/overview').set(as('co')).expect(200);
        const region = co.body.rows.find((r: { desertCities: number }) => r.desertCities > 0);
        const reg = await api().get(`/api/v1/dashboard/overview?level=REGION&code=${region.code}`).set(as('co')).expect(200);
        const prov = reg.body.rows.find((r: { desertCities: number }) => r.desertCities > 0);
        expect(prov).toBeDefined();
        const ov = await api().get(`/api/v1/dashboard/overview?level=PROVINCE&code=${prov.code}`).set(as('co')).expect(200);
        const deserts = ov.body.rows.filter((r: { desertLevel: number }) => r.desertLevel > 0);
        expect(deserts.length).toBe(ov.body.deserts.cities);
        for (const c of deserts) {
          const lvl = c.candidates <= 20 ? 1 : c.candidates <= 40 ? 2 : c.candidates <= 60 ? 3 : 4;
          expect(c.desertLevel).toBe(lvl);
          expect(c.nearestMinutes).toBeNull(); // no center within the travel range
        }
        // deserts come first in the list, most candidates first
        const first = ov.body.rows.slice(0, deserts.length);
        expect(first.every((r: { desertLevel: number }) => r.desertLevel > 0)).toBe(true);
        expect(first.map((r: { candidates: number }) => r.candidates)).toEqual(
          [...first.map((r: { candidates: number }) => r.candidates)].sort((a: number, b: number) => b - a),
        );
      });

      it('every row has a density class, and the densest fifth is the hotspot', async () => {
        const ov = await api().get('/api/v1/dashboard/overview').set(as('co')).expect(200);
        for (const r of ov.body.rows) {
          for (const k of ['ratio', 'slots', 'used']) expect(r).not.toHaveProperty(k); // no capacity model
          expect(r.densityBand).toBeGreaterThanOrEqual(-1);
        }
        const legend = ov.body.densityLegend;
        const top = legend[legend.length - 2];
        expect(top.label).toContain('hotspot');
        expect(legend[legend.length - 1]).toMatchObject({ band: -1, label: 'No candidates' });
        const hot = ov.body.rows.filter((r: { densityBand: number }) => r.densityBand === top.band);
        expect(hot.length).toBeGreaterThan(0);
        expect(hot.length).toBeLessThanOrEqual(Math.ceil(ov.body.rows.length * 0.4)); // roughly the top fifth
        const minHot = Math.min(...hot.map((r: { candidates: number }) => r.candidates));
        for (const r of ov.body.rows) if (r.densityBand !== top.band) expect(r.candidates).toBeLessThanOrEqual(minHot);
      });

      it('PO sees deserts only inside their province, and the map carries the same fields', async () => {
        const ov = await api().get('/api/v1/dashboard/overview').set(as('po')).expect(200);
        expect(ov.body.deserts.cities).toBe(ov.body.rows.filter((r: { desertLevel: number }) => r.desertLevel > 0).length);
        const map = await api().get('/api/v1/dashboard/map').set(as('po')).expect(200);
        expect(map.body.properties.desertLegend).toHaveLength(5);
        expect(map.body.properties.densityLegend.length).toBeGreaterThan(1);
        const f = map.body.features[0].properties;
        for (const k of ['desertLevel', 'densityBand', 'desertCities']) expect(f).toHaveProperty(k);
      });

      it('marks city candidate counts that are an even share of a province total, but not the measured province total', async () => {
        const po = await api().get('/api/v1/dashboard/overview').set(as('po')).expect(200);
        const est = po.body.rows.filter((r: { estimatedCandidates: number }) => r.estimatedCandidates > 0);
        expect(est.length).toBeGreaterThan(0);
        for (const r of po.body.rows) expect(r.estimatedCandidates === 0 || r.estimatedCandidates === r.candidates).toBe(true);
        const co = await api().get('/api/v1/dashboard/overview').set(as('co')).expect(200);
        for (const r of co.body.rows) expect(r.estimatedCandidates).toBe(0); // provinces: BSRS totals, measured
      });

      it('RO cannot read the deserts of a region outside theirs', () =>
        api().get('/api/v1/dashboard/overview?level=REGION&code=0700000000').set(as('ro')).expect(403));
    });

    it('centers list carries predicted candidates and their reach-based service rate (TESDA only)', () =>
      api()
        .get('/api/v1/dashboard/centers')
        .set(as('po'))
        .expect(200)
        .expect((r) => {
          expect(r.body.length).toBeGreaterThan(0);
          expect(r.body[0]).toHaveProperty('predictedCandidates');
          expect(r.body[0]).toHaveProperty('reach');
          expect(r.body[0]).toHaveProperty('serviceRate');
          expect(r.body[0].reach).toBeGreaterThanOrEqual(r.body[0].predictedCandidates);
          expect(r.body[0].serviceRate).toBeGreaterThanOrEqual(0);
          expect(r.body[0].serviceRate).toBeLessThanOrEqual(1);
          for (const k of ['slots', 'taken', 'utilization']) expect(r.body[0]).not.toHaveProperty(k);
        }));
  });

  describe('centers', () => {
    let centerId: number;
    beforeAll(async () => {
      const r = await api().get('/api/v1/dashboard/centers').set(as('po'));
      centerId = r.body[0].id;
    });

    it('center card shows predicted candidates and the reach-based service rate', () =>
      api()
        .get(`/api/v1/centers/${centerId}`)
        .set(as('po'))
        .expect(200)
        .expect((r) => {
          expect(r.body.current).toHaveProperty('predictedCandidates');
          expect(r.body.current).toHaveProperty('reach');
          expect(r.body.current).toHaveProperty('serviceRate');
          expect(r.body.current.reach).toBeGreaterThanOrEqual(r.body.current.predictedCandidates);
          expect(r.body.current.serviceRate).toBeGreaterThanOrEqual(0);
          expect(r.body.current.serviceRate).toBeLessThanOrEqual(1);
          for (const k of ['utilization', 'taken', 'slotsPerQuarter', 'slots']) expect(r.body.current).not.toHaveProperty(k);
          expect(r.body).not.toHaveProperty('nextQuarter');
        }));

    it('reach returns the 90-minute area as GeoJSON', () =>
      api()
        .get(`/api/v1/centers/${centerId}/reach`)
        .set(as('po'))
        .expect(200)
        .expect((r) => expect(r.body.properties.citiesWithinLimit).toBeGreaterThan(0)));

    describe('isochrone (true travel-time polygons)', () => {
      // Needs TRAVEL_MODEL=osrm and the OSRM server; without them the endpoint answers 503 and the shape checks are skipped.
      it('returns nested 30 / 60 / 90 minute bands around the center, and the 90-minute outline', async () => {
        const r = await api().get('/api/v1/centers/2782/isochrone').set(as('po'));
        expect([200, 503]).toContain(r.status);
        if (r.status === 503) return;
        expect(r.body.properties.minutes).toEqual([30, 60, 90]);
        const bands = r.body.features.filter((f: { properties: { kind: string } }) => f.properties.kind === 'band');
        const limit = r.body.features.find((f: { properties: { kind: string } }) => f.properties.kind === 'limit');
        expect(bands.map((b: { properties: { band: number } }) => b.properties.band)).toEqual([0, 1, 2]);
        expect(limit).toBeDefined();
        const c = r.body.properties.center;
        const here = point([c.lon, c.lat]);
        expect(booleanPointInPolygon(here, bands[0])).toBe(true); // the center is in the first band
        expect(booleanPointInPolygon(here, limit)).toBe(true);
        // each band is bigger than the one inside it, up to the 90-minute outline
        const sq = (f: Parameters<typeof area>[0]) => area(f);
        expect(sq(limit)).toBeGreaterThan(sq(bands[0]));
        // a point far out to sea is not reachable
        expect(booleanPointInPolygon(point([c.lon - 1.5, c.lat + 0.3]), limit)).toBe(false);
        expect(r.body.properties.reachedPoints).toBeGreaterThan(100);
      });

      it('is scoped like the reach map: a PO cannot ask about a center in another province', async () => {
        const co = await api().get('/api/v1/dashboard/centers?level=PROVINCE&code=0702200000').set(as('co'));
        const other = co.body[0]?.id;
        if (!other) return;
        await api().get(`/api/v1/centers/${other}/isochrone`).set(as('po')).expect(403);
      });
    });

    it('PO cannot open a center in another province', async () => {
      const r = await api().get('/api/v1/dashboard/centers?level=PROVINCE&code=0305400000').set(as('co'));
      await api().get(`/api/v1/centers/${r.body[0].id}`).set(as('po')).expect(403);
    });
  });

  describe('simulation', () => {
    it('the removed routes are gone: run list, trigger, trend, geo boundary and cities', async () => {
      await api().get('/api/v1/simulation/runs').set(as('co')).expect(404);
      await api().post('/api/v1/simulation/runs').set(as('co')).send({}).expect(404);
      await api().get('/api/v1/dashboard/trend').set(as('co')).expect(404);
      await api().get('/api/v1/geo/boundary?level=REGION&code=0600000000').expect(404);
      await api().get('/api/v1/geo/provinces/0604500000/cities').expect(404);
    });

    it('drag and drop inside the province improves the area', () =>
      api()
        .post('/api/v1/simulation/what-if')
        .set(as('po'))
        .send({ lat: 9.9906, lon: 122.8142 })
        .expect(200)
        .expect((r) => {
          expect(r.body.area.code).toBe(NEGROS_OCC);
          expect(r.body.area.flaggedAfter).toBeLessThanOrEqual(r.body.area.flaggedBefore);
          expect(r.body.pinDemand).toBeGreaterThanOrEqual(0);
          expect(r.body).not.toHaveProperty('pinTaken');
        }));

    it('breaks the result down by the region and province where the pin lands, as far as the role may see', async () => {
      const pin = { lat: 9.752, lon: 122.405 }; // Sipalay, Negros Occidental, Region VI
      const co = await api().post('/api/v1/simulation/what-if').set(as('co')).send(pin).expect(200);
      expect(co.body.placeAreas.map((a: { level: string }) => a.level)).toEqual(['REGION', 'PROVINCE']);
      expect(co.body.placeAreas[0].code).toBe(R6);
      expect(co.body.placeAreas[1].code).toBe(NEGROS_OCC);
      const ro = await api().post('/api/v1/simulation/what-if').set(as('ro')).send(pin).expect(200);
      expect(ro.body.area.code).toBe(R6);
      expect(ro.body.placeAreas.map((a: { level: string }) => a.level)).toEqual(['PROVINCE']);
      const po = await api().post('/api/v1/simulation/what-if').set(as('po')).send(pin).expect(200);
      expect(po.body.area.code).toBe(NEGROS_OCC);
      expect(po.body.placeAreas).toEqual([]); // the province is already `area`; nothing wider for a PO
      // the same pin gives the same province numbers whoever asks
      expect(ro.body.placeAreas[0].flaggedAfter).toBe(co.body.placeAreas[1].flaggedAfter);
      expect(co.body.placeAreas[1].flaggedAfter).toBe(po.body.area.flaggedAfter);
    });

    it('reports assessment deserts closed by the new center', async () => {
      // find a desert city, drop the pin in it, and the desert count must go down
      const nat = await api().get('/api/v1/dashboard/overview').set(as('co')).expect(200);
      const region = nat.body.rows.find((r: { desertCities: number }) => r.desertCities > 0);
      const reg = await api().get(`/api/v1/dashboard/overview?level=REGION&code=${region.code}`).set(as('co')).expect(200);
      const prov = reg.body.rows.find((r: { desertCities: number }) => r.desertCities > 0);
      const ov = await api().get(`/api/v1/dashboard/overview?level=PROVINCE&code=${prov.code}`).set(as('co')).expect(200);
      const city = ov.body.rows.find((r: { desertLevel: number }) => r.desertLevel > 0);
      const places = await api().get(`/api/v1/public/places?q=${encodeURIComponent(city.name)}`).expect(200);
      const place = places.body.find((p: { key: string }) => p.key === city.code);
      expect(place).toBeDefined();
      const r = await api()
        .post('/api/v1/simulation/what-if')
        .set(as('co'))
        .send({ lat: place.lat, lon: place.lon })
        .expect(200);
      expect(r.body.national.desertCitiesAfter).toBeLessThan(r.body.national.desertCitiesBefore);
      expect(r.body.placeAreas[1].desertCitiesAfter).toBeLessThan(r.body.placeAreas[1].desertCitiesBefore);
    });

    describe('snapping a hand-placed pin to the nearest road', () => {
      const snap = (who: 'co' | 'ro' | 'po', q: string) => api().get(`/api/v1/simulation/snap?${q}`).set(as(who));

      it('moves a pin onto a road within 5 km and says which road and how far', async () => {
        const r = await snap('co', 'lat=10.519&lon=119.586').expect(200); // Dumaran, Palawan: a point off the road
        if (r.body.onRoad) {
          expect(r.body.movedMeters).toBeLessThanOrEqual(5000);
          expect(Math.abs(r.body.lat - 10.519)).toBeLessThan(0.1);
          expect(Math.abs(r.body.lon - 119.586)).toBeLessThan(0.1);
        } else {
          expect(r.body).toMatchObject({ lat: 10.519, lon: 119.586, movedMeters: 0 }); // routing is off: it stays put
        }
        if (process.env.TRAVEL_MODEL === 'osrm') expect(r.body.onRoad).toBe(true);
      });

      it('leaves a pin where it is when no road is near (open sea)', async () => {
        const r = await snap('co', 'lat=11.5&lon=118.0').expect(200);
        expect(r.body).toMatchObject({ onRoad: false, lat: 11.5, lon: 118, movedMeters: 0, roadName: null });
      });

      it('never moves a pin outside the chosen area or the office area', async () => {
        // a road point just inside Negros Occidental could be over the border, so a snap must stay inside when asked
        const r = await snap('co', `lat=9.752&lon=122.405&level=PROVINCE&code=${NEGROS_OCC}`).expect(200);
        expect(r.body.lat).toBeGreaterThan(9.5);
        await snap('ro', 'lat=9.752&lon=122.405&level=REGION&code=0700000000').expect(403);
        await snap('po', 'lat=9.752&lon=122.405&level=PROVINCE&code=0305400000').expect(403);
      });

      it('checks its input and needs a sign-in', async () => {
        await snap('co', 'lat=95&lon=121').expect(400);
        await snap('co', 'lat=10').expect(400);
        await snap('co', 'lat=10&lon=121&level=PROVINCE').expect(400);
        await api().get('/api/v1/simulation/snap?lat=10&lon=121').expect(401);
      });
    });

    describe('recommended sites for a new center', () => {
      const get = (who: 'co' | 'ro' | 'po', q = '') => api().get(`/api/v1/simulation/recommendations${q}`).set(as(who));
      type Site = { rank: number; cityKey: string; lat: number; lon: number; newlyServed: number; desertCitiesClosed: number; onRoad: boolean; movedMeters: number };

      it('suggests up to 3 desert sites for the home area, best first, without overlap', async () => {
        const r = await get('co').expect(200);
        expect(r.body.area).toMatchObject({ level: 'NATIONAL' });
        expect(r.body.desertCities).toBeGreaterThan(0);
        const sites: Site[] = r.body.sites;
        expect(sites.length).toBeGreaterThan(0);
        expect(sites.length).toBeLessThanOrEqual(3);
        expect(sites.map((s) => s.rank)).toEqual(sites.map((_, i) => i + 1));
        for (let i = 1; i < sites.length; i++) expect(sites[i]!.newlyServed).toBeLessThanOrEqual(sites[i - 1]!.newlyServed);
        expect(new Set(sites.map((s) => s.cityKey)).size).toBe(sites.length);
        expect(sites.reduce((n, s) => n + s.newlyServed, 0)).toBeLessThanOrEqual(r.body.desertCandidates);
      });

      it('puts the pin on a road when the routing server is up, within 3 km of the city point', async () => {
        const r = await get('co').expect(200);
        const sites: Site[] = r.body.sites;
        for (const s of sites) {
          expect(s.movedMeters).toBeLessThanOrEqual(3000);
          if (!s.onRoad) expect(s.movedMeters).toBe(0);
        }
        if (process.env.TRAVEL_MODEL === 'osrm') expect(sites.some((s) => s.onRoad)).toBe(true);
      });

      it('a suggested pin really closes deserts in the what-if', async () => {
        const r = await get('co').expect(200);
        const best: Site = r.body.sites[0];
        const w = await api().post('/api/v1/simulation/what-if').set(as('co')).send({ lat: best.lat, lon: best.lon }).expect(200);
        expect(w.body.newlyServed).toBeGreaterThan(0);
        expect(w.body.national.desertCitiesAfter).toBeLessThan(w.body.national.desertCitiesBefore);
      });

      it('says which qualifications each site should offer, from the graduates of the provinces it serves', async () => {
        const r = await get('co', `?level=PROVINCE&code=${NEGROS_OCC}&count=3`).expect(200);
        expect(r.body.qualificationSource).toContain('graduate');
        const sites = r.body.sites as Array<{ topQualifications: Array<{ qualification: string; qualificationId: number; estimatedCandidates: number; share: number; centersOffering: number }>; newlyServed: number }>;
        expect(sites.length).toBeGreaterThan(0);
        for (const site of sites) {
          expect(site.topQualifications.length).toBeGreaterThan(0);
          expect(site.topQualifications.length).toBeLessThanOrEqual(3);
          const est = site.topQualifications.map((q) => q.estimatedCandidates);
          expect(est).toEqual([...est].sort((x, y) => y - x)); // most wanted first
          for (const q of site.topQualifications) {
            expect(Number.isInteger(q.qualificationId)).toBe(true);
            expect(q.share).toBeGreaterThan(0);
            expect(q.share).toBeLessThanOrEqual(1);
            expect(q.estimatedCandidates).toBeLessThanOrEqual(site.newlyServed); // no more wanted than the candidates served
            expect(q.centersOffering).toBeGreaterThanOrEqual(0);
          }
        }
      });

      it('has no learner data in the qualification figures: only counts per province', async () => {
        const rows: Array<Record<string, unknown>> = await app.get(DataSource).query(`SELECT * FROM province_qualification_graduates LIMIT 50`);
        expect(rows.length).toBeGreaterThan(0);
        expect(Object.keys(rows[0]!).sort()).toEqual(['graduates', 'province_psgc', 'qualification', 'qualification_id']);
      });

      it('looks only inside a chosen province, and keeps role scope', async () => {
        const r = await get('co', `?level=PROVINCE&code=${NEGROS_OCC}&count=5`).expect(200);
        expect(r.body.area).toMatchObject({ level: 'PROVINCE', code: NEGROS_OCC });
        expect(r.body.sites.length).toBeLessThanOrEqual(5);
        const po = await get('po').expect(200);
        expect(po.body.area.code).toBe(NEGROS_OCC);
        await get('ro', '?level=REGION&code=0700000000').expect(403);
        await get('po', '?level=PROVINCE&code=0305400000').expect(403);
      });

      it('a shorter travel limit finds more deserts, and bad input is refused', async () => {
        const base = await get('co').expect(200);
        const tight = await get('co', '?limitMinutes=30').expect(200);
        expect(tight.body.desertCities).toBeGreaterThanOrEqual(base.body.desertCities);
        expect(tight.body.limitMinutes).toBe(30);
        await get('co', '?count=0').expect(400);
        await get('co', '?count=6').expect(400);
        await get('co', '?limitMinutes=5').expect(400);
      });
    });

    describe('planning inside a chosen region or province', () => {
      const pin = { lat: 9.752, lon: 122.405 }; // Sipalay, Negros Occidental, Region VI
      const post = (who: 'co' | 'ro' | 'po', body: object) => api().post('/api/v1/simulation/what-if').set(as(who)).send(body);

      it('reports on that province (CO), and on the region when asked for it', async () => {
        const prov = await post('co', { ...pin, level: 'PROVINCE', code: NEGROS_OCC }).expect(200);
        expect(prov.body.area).toMatchObject({ level: 'PROVINCE', code: NEGROS_OCC });
        const reg = await post('co', { ...pin, level: 'REGION', code: R6 }).expect(200);
        expect(reg.body.area).toMatchObject({ level: 'REGION', code: R6 });
        const home = await post('co', pin).expect(200);
        expect(home.body.area.level).toBe('NATIONAL'); // without a choice it is still the home area
      });

      it('refuses a pin outside the chosen province, even if the office could see it', async () => {
        const r = await post('co', { lat: 10.3157, lon: 123.8854, level: 'PROVINCE', code: NEGROS_OCC }).expect(400); // Cebu
        expect(JSON.stringify(r.body.message)).toContain('Negros Occidental');
      });

      it('keeps role scope: RO and PO cannot plan in an area outside theirs', async () => {
        await post('ro', { ...pin, level: 'REGION', code: '0700000000' }).expect(403);
        await post('po', { ...pin, level: 'PROVINCE', code: '0305400000' }).expect(403);
        await post('po', { ...pin, level: 'PROVINCE', code: NEGROS_OCC }).expect(200);
        await post('ro', { ...pin, level: 'PROVINCE', code: NEGROS_OCC }).expect(200); // a province of their own region
      });

      it('needs level and code together, and only region or province', async () => {
        await post('co', { ...pin, level: 'PROVINCE' }).expect(400);
        await post('co', { ...pin, code: NEGROS_OCC }).expect(400);
        await post('co', { ...pin, level: 'NATIONAL', code: 'PH' }).expect(400);
      });
    });

    it('a pin outside the user area is refused', () =>
      api()
        .post('/api/v1/simulation/what-if')
        .set(as('po'))
        .send({ lat: 10.3157, lon: 123.8854 })
        .expect(400));

    it('validates the pin, and no longer accepts a slot count', async () => {
      await api().post('/api/v1/simulation/what-if').set(as('co')).send({ lat: 95, lon: 121 }).expect(400);
      await api().post('/api/v1/simulation/what-if').set(as('co')).send({ lat: 15, lon: 121, slotsPerQuarter: 250 }).expect(400);
    });
  });

  describe('public learner finder (no sign-in)', () => {
    it('searches places', () =>
      api()
        .get('/api/v1/public/places?q=Malolos')
        .expect(200)
        .expect((r) => expect(r.body[0].name).toContain('Malolos')));

    it('lists qualifications offered by centers', () =>
      api()
        .get('/api/v1/public/qualifications?q=cookery')
        .expect(200)
        .expect((r) => expect(r.body.length).toBeGreaterThan(0)));

    it('finds the nearest centers from a location, without congestion or learner data', () =>
      api()
        .get('/api/v1/public/centers/nearest?lat=14.8433&lon=120.8114&limit=5')
        .expect(200)
        .expect((r) => {
          expect(r.body.results).toHaveLength(5);
          expect(r.body.results[0].minutes).toBeLessThanOrEqual(r.body.results[4].minutes);
          expect(r.body.results[0].directionsUrl).toMatch(/^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&origin=14\.8433,120\.8114&destination=/);
          expect(r.body.results[0]).not.toHaveProperty('predictedCandidates');
          expect(r.body.results[0]).not.toHaveProperty('utilization');
          expect(r.body.desert).toBe(false);
        }));

    it('lists a center within 500 m as a walk, with the same time the walking directions give', async () => {
      const near = await api().get('/api/v1/public/centers/nearest?lat=14.521465&lon=121.029221&limit=3').expect(200);
      const first = near.body.results[0];
      expect(first.id).toBe(30); // TESDA Women's Center, about 220 m away
      expect(first.mode).toBe('walking');
      expect(first.withinLimit).toBe(true);
      const far = near.body.results.find((r: { km: number }) => r.km > 0.6);
      if (far) expect(far.mode).toBe('driving');
      const walk = await api().get('/api/v1/public/route?lat=14.521465&lon=121.029221&centerId=30').expect(200);
      expect(walk.body.minutes).toBe(first.minutes);
    });

    it('filters by a TESDA qualification label, including one with no T2MIS QualId', async () => {
      const quals = await api().get('/api/v1/public/qualifications').expect(200);
      expect(quals.body[0].label).toMatch(/ NC (I|II|III|IV)$|[^I]$/);
      const unmatched = quals.body.find((q: { id: number | null }) => q.id === null);
      expect(unmatched).toBeDefined();
      const r = await api()
        .get(`/api/v1/public/centers/nearest?lat=14.5995&lon=120.9842&limit=20&qualification=${encodeURIComponent(unmatched.label)}`)
        .expect(200);
      expect(r.body.filters.qualification).toBe(unmatched.label);
      for (const c of r.body.results) expect(c.qualifications).toContain(unmatched.label);
      expect(r.body.programData.centersWithProgramData).toBeGreaterThan(0);
    });

    it('lists only centers the TESDA API lists', async () => {
      const [unlisted] = await app.get(DataSource).query(
        `SELECT id, lat, lon FROM assessment_centers WHERE tesda_listed = false ORDER BY id LIMIT 1`,
      );
      if (!unlisted) return; // never synced: the seed's centers are all in the analysis
      const r = await api().get(`/api/v1/public/centers/nearest?lat=${unlisted.lat}&lon=${unlisted.lon}&limit=20`);
      if (r.status !== 200) return; // that point is at sea
      expect(r.body.results.map((c: { id: number }) => c.id)).not.toContain(unlisted.id);
    });

    it('refuses a point at sea', () =>
      api().get('/api/v1/public/centers/nearest?lat=13.0&lon=125.9').expect(400));

    describe('turn-by-turn route', () => {
      // Needs TRAVEL_MODEL=osrm and the OSRM server; without them the endpoint says 503 and these shape checks are skipped.
      const route = (q: string) => api().get(`/api/v1/public/route?${q}`);

      it('returns the route line and steps to a center, without congestion data', async () => {
        const near = await api().get('/api/v1/public/centers/nearest?lat=14.8433&lon=120.8114&limit=5').expect(200);
        // The nearest center can be within walking distance (500 m); take the farthest of the five so this is a driving route.
        const c = near.body.results[near.body.results.length - 1];
        expect(c.km).toBeGreaterThan(0.5);
        const r = await route(`lat=14.8433&lon=120.8114&centerId=${c.id}`);
        expect([200, 503]).toContain(r.status);
        if (r.status === 503) return;
        expect(r.body.mode).toBe('driving');
        expect(r.body.geometry.type).toBe('LineString');
        expect(r.body.geometry.coordinates.length).toBeGreaterThan(1);
        expect(r.body.steps.length).toBeGreaterThan(1);
        expect(r.body.steps[0].instruction).toMatch(/^Head /);
        expect(r.body.steps[r.body.steps.length - 1].instruction).toMatch(/arrived/);
        expect(r.body.center.id).toBe(c.id);
        expect(r.body.snapped.start.distanceM).toBeGreaterThanOrEqual(0);
        expect(r.body.snapped.end).toHaveProperty('lat');
        expect(typeof r.body.locationVerified).toBe('boolean');
        expect(r.body).not.toHaveProperty('utilization');
        expect(r.body.center).not.toHaveProperty('predictedCandidates');
      });

      it('says to walk when the center is within 500 m: on footpaths and roads when the foot server is up, else a straight line', async () => {
        // TESDA Women's Center (id 30) is about 220 m from this point
        const r = await route('lat=14.521465&lon=121.029221&centerId=30').expect(200);
        expect(r.body.mode).toBe('walking');
        expect(r.body.steps[0].mode).toBe('walking');
        expect(r.body.km).toBeLessThan(0.5);
        expect(r.body.hasFerry).toBe(false);
        if (r.body.travelModel.startsWith('osrm(foot')) {
          expect(r.body.geometry.coordinates.length).toBeGreaterThan(2); // follows the road network
          expect(r.body.steps[0].instruction).toMatch(/^Head /);
          expect(r.body.snapped.start.distanceM).toBeGreaterThan(0);
        } else {
          expect(r.body.geometry.coordinates).toHaveLength(2); // straight-line guide
          expect(r.body.steps[0].instruction).toMatch(/^Walk about \d+ m \w+ to the center$/);
        }
      });

      it('drives (road + ferry) when the center is farther than 500 m', async () => {
        const r = await route('lat=14.8433&lon=120.8114&centerId=30');
        expect([200, 503]).toContain(r.status);
        if (r.status === 200) expect(r.body.mode).toBe('driving');
      });

      it('rejects a missing or unknown center and a point at sea', async () => {
        await route('lat=14.8433&lon=120.8114').expect(400);
        await route('lat=14.8433&lon=120.8114&centerId=99999999').expect(404);
        await route('lat=13.0&lon=125.9&centerId=1343').expect((r) => expect([400, 404]).toContain(r.status));
      });

      it('rejects fields it does not know', () => route('lat=14.8433&lon=120.8114&centerId=1343&toLat=1').expect(400));
    });
  });
});
