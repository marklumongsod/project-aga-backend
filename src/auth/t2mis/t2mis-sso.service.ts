import { ConflictException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Province, Region, User } from '../../database/entities';
import { nowEpoch } from '../../database/epoch';
import { T2misSsoConfigDto } from '../auth.dto';
import {
  AreaLookup,
  claimEmail,
  displayName,
  frontendCallbackUrl,
  normalizeRoles,
  parseRoleMap,
  pickRoleTarget,
  resolveScope,
  RoleTarget,
} from './t2mis-claims';
import { Claims, T2misOidcClient } from './t2mis-oidc.client';

const AREA_CACHE_MS = 60 * 60 * 1000;

/**
 * T2MIS single sign-on: the frontend runs the SSOPortal redirect (authorization code + PKCE) and hands the code
 * here. The account is found by `t2mis_user_id` (= the SSO `sub`), or by email for an existing AGA account not yet
 * linked, or created. Role and area scope are refreshed from the claims at every sign-in; `is_active = false`
 * still blocks the account. No password, token or learner data is stored.
 */
@Injectable()
export class T2misSsoService {
  private readonly logger = new Logger(T2misSsoService.name);
  private readonly roleMap: Map<string, RoleTarget>;
  private areas?: { at: number; lookup: AreaLookup };

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Region) private readonly regions: Repository<Region>,
    @InjectRepository(Province) private readonly provinces: Repository<Province>,
    private readonly oidc: T2misOidcClient,
    private readonly config: ConfigService,
  ) {
    this.roleMap = parseRoleMap(config.get<string>('T2MIS_SSO_ROLE_MAP', 'CAD=CO,SU=CO,Admin=CO,RO=AUTO'));
  }

  /** What the frontend needs to start the SSOPortal redirect. */
  async publicConfig(): Promise<T2misSsoConfigDto> {
    const md = await this.oidc.metadata();
    return {
      authorizationEndpoint: md.authorization_endpoint,
      endSessionEndpoint: md.end_session_endpoint ?? null,
      clientId: this.oidc.clientId,
      redirectUri: this.oidc.redirectUri,
      scope: this.oidc.scope,
      codeChallengeMethod: 'S256',
    };
  }

  /** Where `GET /api/auth/callback` sends the browser: the frontend's /sso/callback with the code and state. 501 if off. */
  callbackRedirect(query: Record<string, unknown>): string {
    this.oidc.assertConfigured();
    return frontendCallbackUrl(this.config.get<string>('T2MIS_SSO_APP_URL'), this.oidc.redirectUri, query);
  }

  /** Verifies the sign-in with SSOPortal and returns the (created or refreshed) AGA account. */
  async signIn(code: string, codeVerifier: string): Promise<User> {
    const claims = await this.oidc.exchangeCode(code, codeVerifier);
    const sub = claims.sub!;
    const ssoRoles = normalizeRoles(claims.role);

    const target = pickRoleTarget(ssoRoles, this.roleMap);
    if (!target) {
      this.logger.warn(`T2MIS sign-in refused: sub=${sub} roles=[${ssoRoles.join(',')}] not mapped to an AGA role`);
      throw new ForbiddenException('Your T2MIS role does not have access to Project AGA');
    }
    const scope = resolveScope(target, claims.RegionId, claims.ProvinceId, await this.areaLookup());
    if (!scope.ok) {
      // Area ids are not personal data; they are logged so the real T2MIS format can be confirmed.
      this.logger.warn(
        `T2MIS sign-in refused: sub=${sub} target=${target} RegionId=${JSON.stringify(claims.RegionId ?? null)} ` +
          `ProvinceId=${JSON.stringify(claims.ProvinceId ?? null)}: ${scope.reason}`,
      );
      throw new ForbiddenException(
        `Your T2MIS account has ${scope.reason}. Ask your T2MIS administrator to set your region or province.`,
      );
    }

    const user = await this.findOrLink(sub, claims);
    if (user && !user.isActive) throw new ForbiddenException('Your Project AGA account is disabled');

    const now = nowEpoch();
    const fields = {
      t2misUserId: sub,
      name: displayName(claims),
      role: scope.scope.role,
      regionPsgc: scope.scope.regionPsgc,
      provincePsgc: scope.scope.provincePsgc,
      lastLoginAt: now,
      updatedAt: now,
    };
    const email = await this.usableEmail(claims, sub, user?.id);
    if (user) {
      await this.users.update(user.id, { ...fields, ...(email ? { email } : {}) });
      return this.users.findOneByOrFail({ id: user.id });
    }
    return this.users.save(
      this.users.create({ ...fields, email: email ?? `${sub}@t2mis.sso.local`, passwordHash: null, isActive: true }),
    );
  }

  private async findOrLink(sub: string, claims: Claims): Promise<User | null> {
    const linked = await this.users.findOneBy({ t2misUserId: sub });
    if (linked) return linked;
    const email = claimEmail(claims);
    if (!email) return null;
    const byEmail = await this.users.createQueryBuilder('u').where('lower(u.email) = lower(:email)', { email }).getOne();
    if (byEmail?.t2misUserId) {
      this.logger.warn(`T2MIS sign-in refused: sub=${sub} email already linked to another T2MIS account`);
      throw new ConflictException('This email is already linked to a different T2MIS account');
    }
    return byEmail; // an existing AGA account with this email adopts the T2MIS identity
  }

  /** The SSO email when it is present and not taken by another account. */
  private async usableEmail(claims: Claims, sub: string, ownId?: string): Promise<string | null> {
    const email = claimEmail(claims);
    if (!email || email.length > 254) return null;
    const other = await this.users.createQueryBuilder('u').where('lower(u.email) = :email', { email }).getOne();
    if (other && other.id !== ownId) {
      this.logger.warn(`T2MIS sign-in: sub=${sub} email is used by another account; keeping the stored email`);
      return null;
    }
    return email;
  }

  private async areaLookup(): Promise<AreaLookup> {
    if (this.areas && Date.now() - this.areas.at < AREA_CACHE_MS) return this.areas.lookup;
    const [regions, provinces] = await Promise.all([
      this.regions.find({ select: { psgc: true } }),
      this.provinces.find({ select: { psgc: true, regionPsgc: true } }),
    ]);
    const lookup: AreaLookup = {
      regions: new Set(regions.map((r) => r.psgc)),
      provinces: new Map(provinces.map((p) => [p.psgc, p.regionPsgc])),
    };
    this.areas = { at: Date.now(), lookup };
    return lookup;
  }
}
