import { plainToInstance, Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
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

  @IsOptional()
  @IsString()
  T2MIS_SSO_ISSUER?: string;

  @IsOptional()
  @IsString()
  T2MIS_SSO_CLIENT_ID?: string;

  @IsOptional()
  @IsString()
  T2MIS_SSO_CLIENT_SECRET?: string;

  @Transform(toInt)
  @IsInt()
  @Min(15)
  @Max(600)
  SIM_LIMIT_MINUTES = 90;

  /**
   * The fastest average straight-line speed on any road (km/h), from the road network itself: even the fastest
   * trips in the routed data average under 65. It is ONLY used to bound how far to look (limit minutes x this speed,
   * ~112 km at 90 minutes) so nothing reachable is missed. Reach is decided by road travel time alone, never by distance.
   */
  @Transform(toInt)
  @IsInt()
  @Min(30)
  @Max(200)
  SIM_MAX_SPEED_KMH = 75;

  @IsString()
  SIM_CRON = '0 2 * * *';

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
