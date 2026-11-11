import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { AreaLevel } from '../database/entities';
import { MAX_LIMIT_MINUTES, MIN_LIMIT_MINUTES } from '../simulation/limits';

export class AreaQueryDto {
  /** Omit to open the user's home area (PH for CO, own region for RO, own province for PO) */
  @ApiPropertyOptional({ enum: [AreaLevel.NATIONAL, AreaLevel.REGION, AreaLevel.PROVINCE] })
  @IsOptional()
  @IsEnum(AreaLevel)
  level?: AreaLevel;

  /** Region or province PSGC (10 digits) */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  code?: string;
}

export class DashboardQueryDto extends AreaQueryDto {
  /**
   * Travel limit in minutes (default: the configured 90). Another value re-runs the simulation for that limit
   * (kept for 30 minutes) instead of reading the stored daily run.
   */
  @ApiPropertyOptional({ minimum: MIN_LIMIT_MINUTES, maximum: MAX_LIMIT_MINUTES })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_LIMIT_MINUTES)
  @Max(MAX_LIMIT_MINUTES)
  limitMinutes?: number;

  /**
   * Limit the analysis to one qualification (a `key` from GET /dashboard/qualifications): its upcoming graduates and
   * only the centers accredited for it. Runs a one-off simulation (kept for 30 minutes).
   */
  @IsOptional()
  @IsString()
  @MaxLength(160)
  qualification?: string;
}

export class QualificationOptionDto {
  /** pass as ?qualification= */
  key: string;
  name: string;
  /** listed centers accredited for it */
  centers: number;
}

export class AreaStatsDto {
  @ApiProperty({ enum: AreaLevel })
  level: AreaLevel;
  code: string;
  name: string;
  /** the area it sits in: a province's region PSGC, a city's province PSGC; null for a region or the country */
  parentCode: string | null;
  candidates: number;
  flagged: number;
  /** flagged / candidates */
  flaggedShare: number;
  /** assessment centers in the area */
  centers: number;
  /** density class of this area among its siblings (see densityLegend): 0..n, the highest is the hotspot; -1 = no candidates */
  densityBand: number;
  /**
   * Cities: assessment desert level 1-4 by candidates (no center within the travel range), 0 = not a desert.
   * Provinces/regions: the highest level among the cities inside.
   */
  desertLevel: number;
  /** desert cities inside this area (a city counts itself) */
  desertCities: number;
  /** candidates living in those desert cities */
  desertCandidates: number;
  /**
   * Cities: the part of `candidates` that is a share of graduates the TESDA API places only in the province (split over
   * its towns), not graduates placed in this town. 0 for provinces, regions and the country, which count every graduate.
   */
  estimatedCandidates: number;
  /** cities: minutes to the nearest reachable center, null = none within the travel limits */
  nearestMinutes: number | null;
  rank?: number;
}

export class RunRefDto {
  id: string;
  /** epoch seconds */
  finishedAt: number | null;
  @ApiProperty({ type: 'object', additionalProperties: true })
  assumptions: Record<string, string | number>;
}

export class LegendBandDto {
  band: number;
  label: string;
  color: string;
}

export class DesertLevelDto {
  level: number;
  label: string;
  cities: number;
  candidates: number;
}

/** Assessment deserts in the area: cities and municipalities with candidates and no center within the travel range */
export class DesertSummaryDto {
  cities: number;
  candidates: number;
  @ApiProperty({ type: () => [DesertLevelDto] })
  byLevel: DesertLevelDto[];
}

export class OverviewDto {
  run: RunRefDto;
  area: AreaStatsDto;
  @ApiProperty({ enum: AreaLevel })
  childLevel: AreaLevel;
  /** Worst first, only areas with flagged candidates: up to 5 regions for the Philippines, up to 3 provinces or cities for a region or province */
  @ApiProperty({ type: () => [AreaStatsDto] })
  top: AreaStatsDto[];
  @ApiProperty({ type: () => [AreaStatsDto] })
  rows: AreaStatsDto[];
  /** assessment deserts inside the area (team doc definition), by level */
  deserts: DesertSummaryDto;
  /** legend for the desert view of the map: band = desert level 0-4 */
  @ApiProperty({ type: () => [LegendBandDto] })
  desertLegend: ReadonlyArray<LegendBandDto>;
  /** legend for the density view of the map: band = AreaStatsDto.densityBand */
  @ApiProperty({ type: () => [LegendBandDto] })
  densityLegend: ReadonlyArray<LegendBandDto>;
}
