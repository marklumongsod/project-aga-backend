/**
 * T2MIS single sign-on against a fake SSOPortal (test/support/fake-t2mis.ts), on the seeded database.
 * The fake must be imported before AppModule (it sets the T2MIS_SSO_* variables).
 */
import { authorize, CLIENT_ID, ISSUER, newVerifier, REDIRECT_URI, startFakeT2mis } from './support/fake-t2mis';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Server } from 'node:http';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/main';

const R6 = '0600000000';
const NEGROS_OCC = '0604500000';
const SUB = 'e2e-sso-'; // every user this suite creates has a t2mis_user_id starting with this

describe('T2MIS single sign-on (e2e)', () => {
  let app: INestApplication<App>;
  let idp: Server;
  let db: DataSource;
  const api = () => request(app.getHttpServer());

  /** POST /auth/sso/t2mis as a fresh client IP (sign-in is limited to 10 calls a minute per IP). */
  let ip = 0;
  const post = (body: object) =>
    api()
      .post('/api/v1/auth/sso/t2mis')
      .set('X-Forwarded-For', `198.51.100.${++ip}`)
      .send(body);
  const signIn = (claims: Record<string, unknown>, opts: { forge?: boolean; verifier?: string } = {}) => {
    const verifier = newVerifier();
    const code = authorize(verifier, claims, opts);
    return post({ code, codeVerifier: opts.verifier ?? verifier });
  };
  const cleanup = () => db.query(`DELETE FROM users WHERE t2mis_user_id LIKE $1`, [`${SUB}%`]);

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    idp = await startFakeT2mis();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
    db = app.get(DataSource);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await new Promise((r) => idp.close(r));
  });

  it('tells the frontend how to start the redirect (authorization code + PKCE)', () =>
    api()
      .get('/api/v1/auth/sso/t2mis')
      .expect(200)
      .expect((r) =>
        expect(r.body).toEqual({
          authorizationEndpoint: `${ISSUER}connect/authorize`,
          endSessionEndpoint: `${ISSUER}connect/logout`,
          clientId: CLIENT_ID,
          redirectUri: REDIRECT_URI,
          scope: 'openid profile roles',
          codeChallengeMethod: 'S256',
        }),
      ));

  it('signs in a Central Office user (SU) and creates the account', async () => {
    const r = await signIn({ sub: `${SUB}co`, email: 'E2E.SSO.CO@tesda.example', name: 'E2E CO', role: 'SU' }).expect(200);
    expect(r.body.tokenType).toBe('Bearer');
    expect(r.body.user).toMatchObject({ role: 'CO', regionPsgc: null, provincePsgc: null, email: 'e2e.sso.co@tesda.example' });
    const me = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${r.body.accessToken}`).expect(200);
    expect(me.body).toMatchObject({ id: r.body.user.id, name: 'E2E CO', role: 'CO' });
    const [row] = await db.query(`SELECT password_hash FROM users WHERE id = $1`, [r.body.user.id]);
    expect(row.password_hash).toBeNull();
  });

  it('signs in a CAD user as Central Office (CAD is the CO)', async () => {
    const r = await signIn({ sub: `${SUB}cad`, name: 'e2e.cad@tesda.example', FirstName: 'E2E', LastName: 'CAD', role: 'CAD', RegionId: '6', ProvinceId: '45' }).expect(200);
    expect(r.body.user).toMatchObject({ role: 'CO', regionPsgc: null, provincePsgc: null, name: 'E2E CAD' });
    await api().get('/api/v1/dashboard/overview?level=NATIONAL').set('Authorization', `Bearer ${r.body.accessToken}`).expect(200);
  });

  it('an RO with a province becomes a PO scoped to it, and keeps to that scope', async () => {
    const r = await signIn({
      sub: `${SUB}po`,
      FirstName: 'E2E',
      LastName: 'Provincial',
      role: ['RO'],
      RegionId: '6',
      ProvinceId: '45',
    }).expect(200);
    expect(r.body.user).toMatchObject({ role: 'PO', regionPsgc: R6, provincePsgc: NEGROS_OCC, name: 'E2E Provincial' });
    const auth = { Authorization: `Bearer ${r.body.accessToken}` };
    await api().get(`/api/v1/dashboard/overview?level=PROVINCE&code=${NEGROS_OCC}`).set(auth).expect(200);
    await api().get('/api/v1/dashboard/overview?level=PROVINCE&code=0305400000').set(auth).expect(403);
    await api().get('/api/v1/dashboard/overview?level=REGION&code=0700000000').set(auth).expect(403);
  });

  it('refreshes role and scope from the claims at every sign-in (same account)', async () => {
    const first = await signIn({ sub: `${SUB}ro`, name: 'E2E RO', role: 'RO', RegionId: '06', ProvinceId: '45' }).expect(200);
    const again = await signIn({ sub: `${SUB}ro`, name: 'E2E RO', role: 'RO, AC', RegionId: R6, ProvinceId: '0' }).expect(200);
    expect(first.body.user.role).toBe('PO');
    expect(again.body.user).toMatchObject({ id: first.body.user.id, role: 'RO', regionPsgc: R6, provincePsgc: null });
    await api()
      .get('/api/v1/dashboard/overview?level=REGION&code=0700000000')
      .set('Authorization', `Bearer ${again.body.accessToken}`)
      .expect(403);
  });

  it('refuses SSO roles that are not mapped to an AGA role', () =>
    signIn({ sub: `${SUB}ac`, name: 'E2E AC', role: 'AC,Institution' })
      .expect(403)
      .expect((r) => expect(r.body.message).toBe('Your T2MIS role does not have access to Project AGA')));

  it('refuses a regional role whose area AGA does not recognise', () =>
    signIn({ sub: `${SUB}noarea`, name: 'E2E', role: 'RO', RegionId: '0', ProvinceId: '0' })
      .expect(403)
      .expect((r) => expect(r.body.message).toMatch(/no region AGA recognises/)));

  it('refuses a disabled account', async () => {
    await signIn({ sub: `${SUB}off`, name: 'E2E off', role: 'Admin' }).expect(200);
    await db.query(`UPDATE users SET is_active = false WHERE t2mis_user_id = $1`, [`${SUB}off`]);
    await signIn({ sub: `${SUB}off`, name: 'E2E off', role: 'Admin' }).expect(403);
  });

  it('refuses a wrong PKCE verifier, an unknown code and a reused code', async () => {
    await signIn({ sub: `${SUB}x`, role: 'SU' }, { verifier: newVerifier() }).expect(401);
    await post({ code: 'not-a-code', codeVerifier: newVerifier() }).expect(401);
    const verifier = newVerifier();
    const code = authorize(verifier, { sub: `${SUB}reuse`, role: 'SU' });
    await post({ code, codeVerifier: verifier }).expect(200);
    await post({ code, codeVerifier: verifier }).expect(401);
  });

  it('refuses tokens not signed with a key from the SSOPortal JWKS', () =>
    signIn({ sub: `${SUB}forged`, role: 'SU' }, { forge: true })
      .expect(401)
      .expect((r) => expect(r.body.message).toBe('T2MIS sign-in could not be verified')));

  it('validates the body', async () => {
    await post({ code: 'x', codeVerifier: 'short' }).expect(400);
    await post({ idToken: 'x' }).expect(400);
  });
});
