/**
 * Rate limits. The public finder and sign-in are limited per client IP; signed-in office users are limited per
 * account with a much bigger budget (an office shares one public IP, and one dashboard page makes 8-10 calls).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';

const PW = process.env.SEED_DEMO_PASSWORD ?? '';

async function boot(): Promise<INestApplication<App>> {
  process.env.NODE_ENV = 'test';
  process.env.TRUST_PROXY = '1'; // so each test request can pose as a different client
  process.env.THROTTLE_LIMIT = '5';
  process.env.THROTTLE_OFFICE_LIMIT = '20';
  process.env.THROTTLE_TTL_MS = '60000';
  jest.resetModules(); // the app reads its environment when AppModule is first imported
  const { Test } = await import('@nestjs/testing');
  const { AppModule } = await import('../src/app.module');
  const { configureApp } = await import('../src/main');
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication<INestApplication<App>>({ logger: false });
  configureApp(app);
  await app.init();
  return app;
}

describe('rate limits: per IP for the public, per account for signed-in users', () => {
  let app: INestApplication<App>;
  const api = () => request(app.getHttpServer());
  const token: Record<string, string> = {};
  const login = async (who: string, email: string, ip: string) => {
    const r = await api().post('/api/v1/auth/login').set('X-Forwarded-For', ip).send({ email, password: PW }).expect(200);
    token[who] = r.body.accessToken;
  };

  beforeAll(async () => {
    app = await boot();
    await login('co', 'co.planning@demo.aga.local', '10.0.0.1');
    await login('po', 'po.negrosoccidental@demo.aga.local', '10.0.0.1');
  });
  afterAll(() => app.close());

  it('the public finder is limited per client IP', async () => {
    const places = (ip: string) => api().get('/api/v1/public/places?q=ba').set('X-Forwarded-For', ip);
    for (let i = 0; i < 5; i++) await places('198.51.100.1').expect(200);
    await places('198.51.100.1').expect(429); // that client used its 5
    await places('198.51.100.2').expect(200); // another client is unaffected
  });

  it('a signed-in user gets a much bigger budget, counted per account, not per IP', async () => {
    const overview = (who: string) => api().get('/api/v1/dashboard/overview').set('Authorization', `Bearer ${token[who]}`).set('X-Forwarded-For', '10.0.0.1');
    // far more than the public limit of 5 (both users sit behind the same IP, as an office does)
    for (let i = 0; i < 15; i++) await overview('co').expect(200);
    for (let i = 0; i < 15; i++) await overview('po').expect(200); // the PO has their own budget, though the CO used 15
    for (let i = 0; i < 5; i++) await overview('co').expect(200); // 20 in all for the CO
    await overview('co').expect(429); // the CO's own budget is used up...
    await overview('po').expect(200); // ...the PO's is not
  });

  it('sign-in keeps its own strict limit of 10 a minute per client', async () => {
    const attempt = (ip: string) => api().post('/api/v1/auth/login').set('X-Forwarded-For', ip).send({ email: 'nobody@demo.aga.local', password: 'nope' });
    for (let i = 0; i < 10; i++) await attempt('203.0.113.7').expect(401);
    await attempt('203.0.113.7').expect(429);
    await attempt('203.0.113.8').expect(401);
  });

  it('an office user and the public do not eat each other\'s budget, and health is never limited', async () => {
    // the public budget of this IP is gone (first test); a signed-in user on a fresh account budget is not affected by it
    await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${token['po']}`).set('X-Forwarded-For', '198.51.100.1').expect(200);
    for (let i = 0; i < 30; i++) await api().get('/api/v1/health').set('X-Forwarded-For', '198.51.100.1').expect(200);
  });
});
