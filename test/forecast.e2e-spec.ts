import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { join } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { ForecastImportService } from '../src/forecast/forecast-import.service';
import { configureApp } from '../src/main';

const PW = process.env.SEED_DEMO_PASSWORD ?? '';
const MODEL_VERSION = 'test-forecast-2026-10';
const R6 = '0600000000';
const NEGROS_OCC = '0604500000';

describe('Forecasts (e2e)', () => {
  let app: INestApplication<App>;
  let ds: DataSource;
  const token: Record<string, string> = {};
  const api = () => request(app.getHttpServer());
  const as = (who: string) => ({ Authorization: `Bearer ${token[who]}` });

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.THROTTLE_LIMIT = '1000';
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
    ds = app.get(DataSource);
    for (const [key, email] of Object.entries({
      co: 'co.planning@demo.aga.local',
      ro: 'ro.region6@demo.aga.local',
      po: 'po.negrosoccidental@demo.aga.local',
    })) {
      const res = await api().post('/api/v1/auth/login').send({ email, password: PW }).expect(200);
      token[key] = res.body.accessToken;
    }
    await ds.query(`DELETE FROM forecast_runs WHERE model_version = $1`, [MODEL_VERSION]);
    await app.get(ForecastImportService).import({
      file: join(__dirname, 'fixtures', 'forecast.json'),
      places: join(__dirname, 'fixtures', 'forecast_places.csv'),
      meta: join(__dirname, 'fixtures', 'forecast_meta.json'),
      modelVersion: MODEL_VERSION,
      replace: true,
      persistPlaces: false,
    });
  });

  afterAll(async () => {
    await ds.query(`DELETE FROM forecast_runs WHERE model_version = $1`, [MODEL_VERSION]);
    await app.close();
  });

  it('reports the latest run, model version and accuracy', async () => {
    const res = await api().get('/api/v1/forecasts/meta').set(as('co')).expect(200);
    expect(res.body.latest.forecastMonth).toBe('2026-10');
    expect(res.body.latest.modelVersion).toBe(MODEL_VERSION);
    expect(res.body.latest.stale).toBe(false);
    expect(res.body.trainedOn).toBe('test fixture');
    expect(res.body.accuracy.national.wape1Month).toBeCloseTo(15.2);
    expect(res.body.accuracy.center.wape1Month).toBeCloseTo(84.7);
  });

  it('returns the national six-month series and its regions', async () => {
    const res = await api().get('/api/v1/forecasts').set(as('co')).expect(200);
    expect(res.body.area).toMatchObject({ level: 'NATIONAL', code: 'PH', name: 'Philippines', available: true });
    expect(res.body.area.forecast).toHaveLength(6);
    expect(res.body.area.forecast[0]).toEqual({ targetMonth: '2026-11', horizon: 1, candidates: 5000 });
    expect(res.body.children).toHaveLength(1);
    expect(res.body.children[0]).toMatchObject({ level: 'REGION', code: R6, available: true });
    expect(res.body.children[0].forecast).toHaveLength(6);
    expect(res.body.coverage).toEqual({ total: 17, withForecast: 1 });
  });

  it('scopes a region to the regional office', async () => {
    const res = await api().get(`/api/v1/forecasts?level=REGION&code=${R6}`).set(as('ro')).expect(200);
    expect(res.body.area).toMatchObject({ level: 'REGION', code: R6, available: true });
    expect(res.body.area.forecast[0].candidates).toBe(5000);
    expect(res.body.children[0]).toMatchObject({ level: 'PROVINCE', code: NEGROS_OCC });
    expect(res.body.coverage).toEqual({ total: 6, withForecast: 1 });
  });

  it('scopes a province to the provincial office and lists its centers', async () => {
    const res = await api()
      .get(`/api/v1/forecasts?level=PROVINCE&code=${NEGROS_OCC}`)
      .set(as('po'))
      .expect(200);
    expect(res.body.area).toMatchObject({ level: 'PROVINCE', code: NEGROS_OCC, available: true });
    expect(res.body.area.forecast[0].candidates).toBe(4000);
    expect(res.body.children).toHaveLength(1);
    expect(res.body.children[0]).toMatchObject({ level: 'CENTER', code: '533', available: true });
    expect(res.body.children[0].forecast[0].candidates).toBe(2500);
    expect(res.body.coverage.withForecast).toBe(1);
    expect(res.body.coverage.total).toBeGreaterThan(1);
  });

  it('returns a center series with no children', async () => {
    const res = await api().get('/api/v1/forecasts?level=CENTER&code=533').set(as('po')).expect(200);
    expect(res.body.area).toMatchObject({ level: 'CENTER', code: '533', available: true });
    expect(res.body.area.forecast).toHaveLength(6);
    expect(res.body.area.forecast[0]).toEqual({ targetMonth: '2026-11', horizon: 1, candidates: 2500 });
    expect(res.body.children).toEqual([]);
    expect(res.body.coverage).toBeNull();
    expect(res.body.accuracy.wape1Month).toBeCloseTo(84.7);
  });

  it('defaults to the user home area', async () => {
    const po = await api().get('/api/v1/forecasts').set(as('po')).expect(200);
    expect(po.body.area).toMatchObject({ level: 'PROVINCE', code: NEGROS_OCC });
    const ro = await api().get('/api/v1/forecasts').set(as('ro')).expect(200);
    expect(ro.body.area).toMatchObject({ level: 'REGION', code: R6 });
  });

  it('rejects a national request from a regional office', () =>
    api().get('/api/v1/forecasts?level=NATIONAL').set(as('ro')).expect(403));

  it('rejects a region outside the user scope', () =>
    api().get('/api/v1/forecasts?level=REGION&code=0300000000').set(as('ro')).expect(403));

  it('rejects a region request from a provincial office', () =>
    api().get(`/api/v1/forecasts?level=REGION&code=${R6}`).set(as('po')).expect(403));

  it('needs a code for region, province and center', () =>
    api().get('/api/v1/forecasts?level=PROVINCE').set(as('co')).expect(400));

  it('returns a closed center as unavailable instead of a 404', async () => {
    const res = await api().get('/api/v1/forecasts?level=CENTER&code=29').set(as('co')).expect(200);
    expect(res.body.area).toMatchObject({ level: 'CENTER', code: '29', available: false });
    expect(res.body.area.forecast).toEqual([]);
    expect(res.body.area.note).toMatch(/Closed center/);
  });

  it('404s for an unknown center', () =>
    api().get('/api/v1/forecasts?level=CENTER&code=999999').set(as('co')).expect(404));
});
