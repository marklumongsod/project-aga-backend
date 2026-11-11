import { plainToInstance, Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  ValidateIf,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum TravelMode {
  Estimate = 'estimate',
  Osrm = 'osrm',
}

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

const toInt = ({ value }: { value: unknown }) =>
  value === undefined || value === '' ? undefined : Number(value);

/** Environment contract. The app refuses to start when it is not met. */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Transform(toInt)
  @IsInt()
  PORT = 3000;

  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;

  /**
   * How many reverse proxies sit in front of the API (0 = none, 1 = nginx or one load balancer). Needed so rate limits
   * and logs use the real client address (X-Forwarded-For) instead of the proxy's. Set it only when the API is NOT also
   * reachable directly, or a client could spoof the header to dodge the limits.
   */
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(10)
  TRUST_PROXY = 0;

  @IsUrl({ protocols: ['postgres', 'postgresql'], require_tld: false })
  DATABASE_URL: string;

  @IsString()
  @MinLength(16)
  JWT_SECRET: string;

  @IsString()
  @IsNotEmpty()
  JWT_EXPIRES_IN = '8h';

  /** T2MIS SSO (SSOPortal / OpenIddict) authority, e.g. https://sso.tesda.gov.ph. Empty = SSO off (501). */
  @ValidateIf((o: EnvironmentVariables) => !!o.T2MIS_SSO_ISSUER)
  @IsUrl({ protocols: ['http', 'https'], require_tld: false, require_protocol: true })
  T2MIS_SSO_ISSUER?: string;

  @ValidateIf((o: EnvironmentVariables) => !!o.T2MIS_SSO_ISSUER)
  @IsString()
  @IsNotEmpty()
  T2MIS_SSO_CLIENT_ID?: string;

  /** Confidential client secret; sent to the token endpoint (client_secret_post). Optional for a public PKCE client. */
  @IsOptional()
  @IsString()
  T2MIS_SSO_CLIENT_SECRET?: string;

  /** The frontend URL SSOPortal sends the user back to (must be registered on the SSO client). */
  @ValidateIf((o: EnvironmentVariables) => !!o.T2MIS_SSO_ISSUER)
  @IsUrl({ protocols: ['http', 'https'], require_tld: false, require_protocol: true })
  T2MIS_SSO_REDIRECT_URI?: string;

  @IsString()
  @IsNotEmpty()
  T2MIS_SSO_SCOPES = 'openid profile roles';

  /**
   * SSO role -> AGA role, comma-separated `SsoRole=Target`. Target CO, RO, PO or AUTO
   * (AUTO = PO when the account's ProvinceId resolves, else RO by RegionId). SSO roles not listed are refused.
   */
  @Matches(/^\s*[\w .-]+\s*=\s*(CO|RO|PO|AUTO)\s*(,\s*[\w .-]+\s*=\s*(CO|RO|PO|AUTO)\s*)*$/i, {
    message: 'T2MIS_SSO_ROLE_MAP must look like CAD=CO,SU=CO,Admin=CO,RO=AUTO (targets CO, RO, PO, AUTO)',
  })
  T2MIS_SSO_ROLE_MAP = 'CAD=CO,SU=CO,Admin=CO,RO=AUTO';

  @Transform(toInt)
  @IsInt()
  @Min(15)
  @Max(600)
  SIM_LIMIT_MINUTES = 90;

  /**
   * The fastest average straight-line speed on any road (km/h), from the road network itself: even the fastest
   * trips in the routed data (Philippine speed limits) average under 85. It is ONLY used to bound how far to look (limit minutes x this speed,
   * ~135 km at 90 minutes) so nothing reachable is missed. Reach is decided by road travel time alone, never by distance.
   */
  @Transform(toInt)
  @IsInt()
  @Min(30)
  @Max(200)
  SIM_MAX_SPEED_KMH = 90;

  @IsString()
  SIM_CRON = '0 2 * * *';

  /** When to pull from the TESDA API (Asia/Manila). Monthly: 01:45 on the 1st, after TESDA's ~01:30 recalculation. */
  @IsString()
  TESDA_SYNC_CRON = '45 1 1 * *';

  /** estimate = straight line x detour / speed (+ ferry). osrm = real road + ferry times from OSRM (OpenStreetMap). */
  @IsEnum(TravelMode)
  TRAVEL_MODEL: TravelMode = TravelMode.Estimate;

  @Transform(({ value }: { value: unknown }) => (value === '' ? undefined : value))
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_tld: false })
  OSRM_URL?: string;

  /** Second OSRM instance with the foot profile, for walking directions to centers within 500 m. */
  @Transform(({ value }: { value: unknown }) => (value === '' ? undefined : value))
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_tld: false })
  OSRM_FOOT_URL?: string;

  @Transform(toInt)
  @IsInt()
  @Min(500)
  OSRM_TIMEOUT_MS = 5000;

  /** TESDA Assessor Coverage API: the source of assessment centers, their qualifications and graduates per school. */
  @IsUrl({ protocols: ['http', 'https'], require_tld: false })
  TESDA_API_URL = 'https://sap-sis.tesda.gov.ph';

  /** X-Api-Key for the coverage endpoints (graduates per school). Without it only centers are synced. */
  @Transform(({ value }: { value: unknown }) => (value === '' ? undefined : value))
  @IsOptional()
  @IsString()
  TESDA_API_KEY?: string;

  @Transform(toInt)
  @IsInt()
  @Min(1000)
  TESDA_API_TIMEOUT_MS = 20000;

  @Transform(toInt)
  @IsInt()
  THROTTLE_TTL_MS = 60000;

  @Transform(toInt)
  @IsInt()
  THROTTLE_LIMIT = 60;

  /** requests per minute per signed-in office user (the public limit above is per IP) */
  @Transform(toInt)
  @IsInt()
  @Min(1)
  THROTTLE_OFFICE_LIMIT = 600;
}

export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  const env = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: false,
    exposeDefaultValues: true,
  });
  const errors = validateSync(env, { skipMissingProperties: false, whitelist: false });
  if (errors.length) {
    const msg = errors
      .map((e) => `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
      .join('; ');
    throw new Error(`Invalid environment configuration - ${msg}`);
  }
  return env;
}
