import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/main';

const PW = process.env.SEED_DEMO_PASSWORD ?? '';
const NEGROS_OCC = '0604500000';
const MODEL_VERSION = 'test-new-center';

const meta = {
  lastMonth: '2026-10',
  latestAccreditationMonth: '2026-11',
  modelVersion: MODEL_VERSION,
  sampleRate: 0.2,
  trainedOn: 'test fixture',
  testAccuracy: { first_year_wape: 119.5, bias: 27.5 },
  versions: { python: '3.11' },
  loadSeconds: 0.1,
};

function prediction(name: string) {
  return {
    name,
    accreditation_month: '2026-11',
    chance_any_candidates: 0.4,
    first_year_expected_sample: 24,
    first_year_expected_real: 120,
    monthly: Array.from({ length: 12 }, (_, i) => ({
      month_since_accreditation: i + 1,
      target_month: `2027-${String(i + 1).padStart(2, '0')}`,
      expected_sample: 2,
      expected_real: 10,
    })),
  };
}

describe('New Center Model (e2e)', () => {
  let app: INestApplication<App>;
  let ds: DataSource;
  let server: Server;
  const token: Record<string, string> = {};
  const api = () => request(app.getHttpServer());
  const as = (who: string) => ({ Authorization: `Bearer ${token[who]}` });

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/meta') {
        res.end(JSON.stringify(meta));
        return;
      }
      if (req.method === 'POST' && req.url === '/predict') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          const parsed = JSON.parse(body || '{}');
          const name = parsed.centers?.[0]?.name ?? 'Planned center';
          res.end(JSON.stringify({ lastMonth: meta.lastMonth, modelVersion: MODEL_VERSION, predictions: [prediction(name)] }));
        });
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    process.env.NEW_CENTER_MODEL_URL = `http://127.0.0.1:${address.port}`;

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
  });

  afterAll(async () => {
    await ds.query(`DELETE FROM new_center_predictions WHERE model_version = $1`, [MODEL_VERSION]);
    await app.close();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns model metadata', async () => {
    const res = await api().get('/api/v1/new-centers/meta').set(as('co')).expect(200);
    expect(res.body.lastMonth).toBe('2026-10');
    expect(res.body.latestAccreditationMonth).toBe('2026-11');
    expect(res.body.modelVersion).toBe(MODEL_VERSION);
    expect(res.body.testAccuracy.first_year_wape).toBeCloseTo(119.5);
  });

  it('predicts a planned center and stores the result', async () => {
    const res = await api()
      .post('/api/v1/new-centers/predict')
      .set(as('co'))
      .send({
        name: 'Planned Negros Center',
        lat: 10.6765,
        lon: 122.9509,
        provincePsgc: NEGROS_OCC,
        qualificationKeys: ['cookery ii'],
        accreditationMonth: '2026-11',
        centerType: 2,
        centerClass: 1,
      })
      .expect(200);
    expect(res.body).toMatchObject({
      modelVersion: MODEL_VERSION,
      lastMonth: '2026-10',
      latestAccreditationMonth: '2026-11',
      chanceAnyCandidates: 0.4,
      firstYearExpected: 120,
    });
    expect(res.body.monthly).toHaveLength(12);
    expect(res.body.monthly[0]).toEqual({ month: 1, targetMonth: '2027-01', expected: 10 });
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);

    const [row] = await ds.query(`SELECT province_psgc, requested_by, model_version FROM new_center_predictions WHERE id = $1`, [
      res.body.id,
    ]);
    expect(row.province_psgc).toBe(NEGROS_OCC);
    expect(row.model_version).toBe(MODEL_VERSION);
  });

  it('scopes the province to the PO and RO', async () => {
    const body = {
      lat: 10.6765,
      lon: 122.9509,
      provincePsgc: NEGROS_OCC,
      qualificationKeys: ['cookery ii'],
      accreditationMonth: '2026-11',
    };
    await api().post('/api/v1/new-centers/predict').set(as('po')).send(body).expect(200);
    await api().post('/api/v1/new-centers/predict').set(as('ro')).send(body).expect(200);
  });

  it('rejects a province outside the user scope', () =>
    api()
      .post('/api/v1/new-centers/predict')
      .set(as('ro'))
      .send({
        lat: 10.6765,
        lon: 122.9509,
        provincePsgc: '0305400000',
        qualificationKeys: ['cookery ii'],
        accreditationMonth: '2026-11',
      })
      .expect(403));

  it('rejects an unknown qualification', () =>
    api()
      .post('/api/v1/new-centers/predict')
      .set(as('co'))
      .send({
        lat: 10.6765,
        lon: 122.9509,
        provincePsgc: NEGROS_OCC,
        qualificationKeys: ['not a qualification'],
        accreditationMonth: '2026-11',
      })
      .expect(400));

  it('rejects an accreditation month after the model cutoff', () =>
    api()
      .post('/api/v1/new-centers/predict')
      .set(as('co'))
      .send({
        lat: 10.6765,
        lon: 122.9509,
        provincePsgc: NEGROS_OCC,
        qualificationKeys: ['cookery ii'],
        accreditationMonth: '2026-12',
      })
      .expect(400));

  it('rejects a pin outside the selected province', () =>
    api()
      .post('/api/v1/new-centers/predict')
      .set(as('co'))
      .send({
        lat: 14.5995,
        lon: 120.9842,
        provincePsgc: NEGROS_OCC,
        qualificationKeys: ['cookery ii'],
        accreditationMonth: '2026-11',
      })
      .expect(400));
});
