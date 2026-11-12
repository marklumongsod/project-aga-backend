/**
 * A stand-in for SSOPortal (OpenIddict) for the SSO e2e tests: discovery, JWKS and a token endpoint that checks
 * client id, secret, redirect URI and PKCE (S256), then returns an RS256 ID token and access token with the claims
 * SSOPortal sends (role, RegionId, ProvinceId, ...).
 *
 * Import this module BEFORE AppModule: it sets the T2MIS_SSO_* variables that ConfigModule validates at import.
 */
import { JwtService } from '@nestjs/jwt';
import { createHash, generateKeyPairSync, KeyObject, randomBytes } from 'node:crypto';
import { createServer, Server } from 'node:http';

const PORT = Number(process.env.FAKE_T2MIS_PORT ?? 47811);
export const ISSUER = `http://127.0.0.1:${PORT}/`;
export const CLIENT_ID = 'aga_client';
export const CLIENT_SECRET = 'aga-e2e-secret';
export const REDIRECT_URI = 'http://localhost:5173/sso/callback';

process.env.T2MIS_SSO_ISSUER = ISSUER;
process.env.T2MIS_SSO_CLIENT_ID = CLIENT_ID;
process.env.T2MIS_SSO_CLIENT_SECRET = CLIENT_SECRET;
process.env.T2MIS_SSO_REDIRECT_URI = REDIRECT_URI;
process.env.T2MIS_SSO_APP_URL = 'http://localhost:5173';
process.env.T2MIS_SSO_SCOPES ='openid profile roles';
process.env.T2MIS_SSO_ROLE_MAP = 'CAD=CO,SU=CO,Admin=CO,RO=AUTO';
// Sign-in allows 10 calls a minute per client IP; behind one (simulated) proxy each test call can be its own client.
process.env.TRUST_PROXY = '1';

const KID = 'e2e-key-1';
const pair = () => generateKeyPairSync('rsa', { modulusLength: 2048 });
const signing = pair();
/** Not in the JWKS: tokens signed with it must be refused. */
const rogue = pair();
const jwt = new JwtService();

interface Grant {
  challenge: string;
  claims: Record<string, unknown>;
  forge?: boolean;
}
const grants = new Map<string, Grant>();
const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');

export const newVerifier = () => randomBytes(48).toString('base64url');

/**
 * What SSOPortal's /connect/authorize does once the user has signed in: remembers the PKCE challenge and the
 * user's claims, and returns the authorization code. `forge` signs the tokens with a key that is not in the JWKS.
 */
export function authorize(verifier: string, claims: Record<string, unknown>, opts: { forge?: boolean } = {}): string {
  const code = randomBytes(16).toString('hex');
  grants.set(code, { challenge: s256(verifier), claims, forge: opts.forge });
  return code;
}

const pem = (k: KeyObject) => k.export({ type: 'pkcs8', format: 'pem' }).toString();
const sign = (payload: Record<string, unknown>, forge?: boolean) =>
  jwt.sign(payload, {
    privateKey: pem(forge ? rogue.privateKey : signing.privateKey),
    algorithm: 'RS256',
    keyid: KID,
    expiresIn: 300,
  });

export function startFakeT2mis(): Promise<Server> {
  const server = createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const path = new URL(req.url ?? '/', ISSUER).pathname;
    if (req.method === 'GET' && path === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}connect/authorize`,
        token_endpoint: `${ISSUER}connect/token`,
        end_session_endpoint: `${ISSUER}connect/logout`,
        jwks_uri: `${ISSUER}.well-known/jwks`,
      });
    }
    if (req.method === 'GET' && path === '/.well-known/jwks') {
      return json(200, { keys: [{ ...signing.publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' }] });
    }
    if (req.method === 'POST' && path === '/connect/token') {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const f = new URLSearchParams(raw);
        const grant = grants.get(f.get('code') ?? '');
        if (
          f.get('grant_type') !== 'authorization_code' ||
          f.get('client_id') !== CLIENT_ID ||
          f.get('client_secret') !== CLIENT_SECRET ||
          f.get('redirect_uri') !== REDIRECT_URI ||
          !grant ||
          s256(f.get('code_verifier') ?? '') !== grant.challenge
        ) {
          return json(400, { error: 'invalid_grant' });
        }
        grants.delete(f.get('code')!); // codes are single use
        const { sub, email, name, ...rest } = grant.claims;
        return json(200, {
          token_type: 'Bearer',
          expires_in: 300,
          id_token: sign({ iss: ISSUER, aud: CLIENT_ID, sub, email, name }, grant.forge),
          access_token: sign({ iss: ISSUER, client_id: CLIENT_ID, sub, email, name, ...rest }, grant.forge),
        });
      });
      return;
    }
    json(404, { error: 'not_found' });
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}
