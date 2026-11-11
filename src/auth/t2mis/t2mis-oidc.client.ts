import {
  BadGatewayException,
  Injectable,
  Logger,
  NotImplementedException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createPublicKey, JsonWebKey } from 'node:crypto';

/** What SSOPortal (OpenIddict) advertises at /.well-known/openid-configuration. */
interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
}

interface Jwk extends JsonWebKey {
  kid?: string;
  use?: string;
}

export type Claims = Record<string, unknown> & { sub?: string };

const CACHE_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;
const ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'] as const;

/**
 * Talks to SSOPortal: discovery, the authorization-code exchange (PKCE + client secret) and token verification
 * against its JWKS. Never logs or stores tokens. TLS is always verified (a dev CA goes in NODE_EXTRA_CA_CERTS).
 */
@Injectable()
export class T2misOidcClient {
  private readonly logger = new Logger(T2misOidcClient.name);
  /** A bare JwtService: the module one would verify with JWT_SECRET instead of the SSO public key. */
  private readonly jwt = new JwtService();
  private discovery?: { at: number; doc: Discovery };
  private jwks?: { at: number; keys: Jwk[] };

  constructor(private readonly config: ConfigService) {}

  get issuer(): string | undefined {
    return this.config.get<string>('T2MIS_SSO_ISSUER') || undefined;
  }
  get clientId(): string {
    return this.config.getOrThrow<string>('T2MIS_SSO_CLIENT_ID');
  }
  get redirectUri(): string {
    return this.config.getOrThrow<string>('T2MIS_SSO_REDIRECT_URI');
  }
  get scope(): string {
    return this.config.get<string>('T2MIS_SSO_SCOPES', 'openid profile roles');
  }

  assertConfigured(): void {
    if (!this.issuer) {
      throw new NotImplementedException('T2MIS single sign-on is not configured yet (set T2MIS_SSO_ISSUER)');
    }
  }

  async metadata(): Promise<Discovery> {
    this.assertConfigured();
    if (this.discovery && Date.now() - this.discovery.at < CACHE_MS) return this.discovery.doc;
    const url = `${this.issuer!.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const doc = (await this.getJson(url)) as Partial<Discovery>;
    for (const k of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
      if (typeof doc[k] !== 'string') throw new BadGatewayException(`T2MIS SSO discovery has no ${k}`);
    }
    this.discovery = { at: Date.now(), doc: doc as Discovery };
    return this.discovery.doc;
  }

  /**
   * Exchanges the authorization code the frontend received and returns the verified claims: the ID token's
   * (audience = our client id) merged with the access token's, which is where SSOPortal puts role, RegionId and
   * ProvinceId. Falls back to userinfo when neither token carries a role.
   */
  async exchangeCode(code: string, codeVerifier: string): Promise<Claims> {
    const md = await this.metadata();
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      code,
      code_verifier: codeVerifier,
    });
    const secret = this.config.get<string>('T2MIS_SSO_CLIENT_SECRET');
    if (secret) form.set('client_secret', secret);

    const res = await this.call(md.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form,
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      // OAuth errors (invalid_grant: expired/used code, wrong verifier) are the user's sign-in failing; anything else is SSOPortal.
      this.logger.warn(`T2MIS token endpoint answered ${res.status} ${String(body.error ?? '')}`);
      if (res.status === 400 || res.status === 401) {
        throw new UnauthorizedException('T2MIS sign-in failed or expired. Please sign in again.');
      }
      throw new BadGatewayException('T2MIS SSO is not responding properly. Try again later.');
    }

    const idToken = typeof body.id_token === 'string' ? body.id_token : undefined;
    const accessToken = typeof body.access_token === 'string' ? body.access_token : undefined;
    let claims: Claims = {};
    if (idToken) claims = await this.verify(idToken, md.issuer, this.clientId);
    // A JWS access token has 3 parts; an encrypted (JWE, 5 parts) or opaque one is only usable at userinfo.
    if (accessToken && accessToken.split('.').length === 3) {
      const at = await this.verify(accessToken);
      if (claims.sub && at.sub !== claims.sub) throw new UnauthorizedException('T2MIS tokens do not match');
      const azp = at.client_id ?? at.azp;
      if (azp !== undefined && azp !== this.clientId) throw new UnauthorizedException('T2MIS token was issued to another app');
      claims = { ...claims, ...at };
    }
    if (claims.role === undefined && accessToken && md.userinfo_endpoint) {
      const info = await this.userinfo(md.userinfo_endpoint, accessToken);
      if (!claims.sub || info.sub === claims.sub) claims = { ...info, ...claims, role: info.role };
    }
    if (typeof claims.sub !== 'string' || !claims.sub) throw new UnauthorizedException('T2MIS sign-in returned no user');
    return claims;
  }

  /** Signature (JWKS), issuer, expiry and, for ID tokens, audience. */
  private async verify(token: string, issuer?: string, audience?: string): Promise<Claims> {
    const md = await this.metadata();
    const header = this.header(token);
    if (!header.alg || !(ALGORITHMS as readonly string[]).includes(header.alg)) {
      throw new UnauthorizedException('T2MIS token uses an unsupported algorithm');
    }
    const jwk = await this.key(header.kid);
    try {
      const publicKey = createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' }).toString();
      return await this.jwt.verifyAsync<Claims>(token, {
        publicKey,
        algorithms: [header.alg as (typeof ALGORITHMS)[number]],
        issuer: issuer ?? md.issuer,
        audience,
        clockTolerance: 60,
      });
    } catch (e) {
      this.logger.warn(`T2MIS token rejected: ${(e as Error).message}`);
      throw new UnauthorizedException('T2MIS sign-in could not be verified');
    }
  }

  private header(token: string): { alg?: string; kid?: string } {
    try {
      return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as { alg?: string; kid?: string };
    } catch {
      throw new UnauthorizedException('T2MIS sign-in could not be verified');
    }
  }

  /** The signing key by kid; the JWKS is fetched again once when the kid is unknown (key rotation). */
  private async key(kid?: string): Promise<Jwk> {
    const md = await this.metadata();
    const pick = (keys: Jwk[]) => {
      const sig = keys.filter((k) => !k.use || k.use === 'sig');
      return kid ? sig.find((k) => k.kid === kid) : sig.length === 1 ? sig[0] : undefined;
    };
    const fresh = !this.jwks || Date.now() - this.jwks.at >= CACHE_MS;
    if (fresh) this.jwks = { at: Date.now(), keys: await this.fetchKeys(md.jwks_uri) };
    let found = pick(this.jwks!.keys);
    if (!found && !fresh) {
      this.jwks = { at: Date.now(), keys: await this.fetchKeys(md.jwks_uri) };
      found = pick(this.jwks.keys);
    }
    if (!found) throw new UnauthorizedException('T2MIS sign-in could not be verified');
    return found;
  }

  private async fetchKeys(url: string): Promise<Jwk[]> {
    const doc = (await this.getJson(url)) as { keys?: Jwk[] };
    return Array.isArray(doc.keys) ? doc.keys : [];
  }

  private async userinfo(url: string, accessToken: string): Promise<Claims> {
    const res = await this.call(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
    if (!res.ok) throw new UnauthorizedException('T2MIS sign-in could not be verified');
    return (await res.json()) as Claims;
  }

  private async getJson(url: string): Promise<unknown> {
    const res = await this.call(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new BadGatewayException('T2MIS SSO is not responding properly. Try again later.');
    return res.json();
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      this.logger.error(`T2MIS SSO unreachable (${new URL(url).origin}): ${(e as Error).message}`);
      throw new BadGatewayException('T2MIS SSO cannot be reached. Try again later.');
    }
  }
}
