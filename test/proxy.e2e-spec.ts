/**
 * Behind a reverse proxy (nginx, a load balancer) every request comes from the proxy's address. The API has to be told
 * to trust X-Forwarded-For, or the per-client rate limits (10 sign-ins a minute) would be shared by everyone.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';

/**
 * The app reads its environment when AppModule is first imported, so set the variables first and load it fresh (in a
 * real deployment they exist before the process starts).
 */
async function boot(trustProxy: string): Promise<INestApplication<App>> {
  process.env.NODE_ENV = 'test';
  process.env.TRUST_PROXY = trustProxy;
  process.env.THROTTLE_LIMIT = '1000';
  jest.resetModules();
  const { Test } = await import('@nestjs/testing');
  const { AppModule } = await import('../src/app.module');
  const { configureApp } = await import('../src/main');
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication<INestApplication<App>>({ logger: false });
  configureApp(app);
  await app.init();
  return app;
}

const attempt = (app: INestApplication<App>, ip: string) =>
  request(app.getHttpServer()).post('/api/v1/auth/login').set('X-Forwarded-For', ip).send({ email: 'nobody@demo.aga.local', password: 'nope' });

describe('rate limits behind a reverse proxy', () => {
  it('with TRUST_PROXY=1, each client is limited on its own', async () => {
    const app = await boot('1');
    try {
      for (let i = 0; i < 10; i++) await attempt(app, '203.0.113.10').expect(401);
      await attempt(app, '203.0.113.10').expect(429); // this client used its 10
      await attempt(app, '203.0.113.99').expect(401); // another client is not affected
    } finally {
      await app.close();
    }
  });

  it('without it (the default), the proxy is the only address the API sees: everyone shares one limit', async () => {
    const app = await boot('0');
    try {
      for (let i = 0; i < 10; i++) await attempt(app, '198.51.100.10').expect(401);
      await attempt(app, '198.51.100.99').expect(429); // a different client, blocked by the first one's attempts
    } finally {
      await app.close();
    }
  });
});
