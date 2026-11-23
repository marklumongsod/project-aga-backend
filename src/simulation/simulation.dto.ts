import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AreaLevel } from '../database/entities';
import { DashboardQueryDto } from '../dashboard/dashboard.dto';
import { MAX_LIMIT_MINUTES, MIN_LIMIT_MINUTES } from './limits';

/** Drag-and-drop: a proposed assessment center. */
export class WhatIfDto {
  @IsLatitude()
  lat: number;

  @IsLongitude()
  lon: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  /**
   * Plan inside one region or province instead of the whole home area: the pin must land in it, and `area` in the
   * result is that region or province. Omit to use the user's home area. Needs `code`.
   */
  @ApiPropertyOptional({ enum: [AreaLevel.REGION, AreaLevel.PROVINCE] })
  @IsOptional()
  @IsIn([AreaLevel.REGION, AreaLevel.PROVINCE])
  level?: AreaLevel;

  /** Region or province PSGC (10 digits) for `level` */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  code?: string;

  /** Travel limit in minutes for this what-if (default: the configured 90) */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_LIMIT_MINUTES)
  @Max(MAX_LIMIT_MINUTES)
  limitMinutes?: number;
}

export class AreaDeltaDto {
  @ApiProperty({ example: 'PROVINCE' })
  level: string;
  code: string;
  name: string;
  candidates: number;
  flaggedBefore: number;
  flaggedAfter: number;
  /** flagged / candidates */
  flaggedShareBefore: number;
  flaggedShareAfter: number;
  /** assessment deserts (cities with candidates and no center within the travel range) before / after the new center */
  desertCitiesBefore: number;
  desertCitiesAfter: number;
}

export class WhatIfPinDto {
  lat: number;
  lon: number;
  cityKey: string | null;
  cityName: string | null;
  /** the province and region the pin is in (absent on proposals saved before these were added) */
  provincePsgc?: string | null;
  provinceName?: string | null;
  regionPsgc?: string | null;
  regionName?: string | null;
}

/** One period of a report area: candidates finishing in it, flagged and deserts, slots and utilization, before / after. */
export class ReportPeriodDto {
  candidates: number;
  flaggedBefore: number;
  flaggedAfter: number;
  desertsBefore: number;
  desertsAfter: number;
  /** slots of the area's centers in the period; null = no slot data */
  slots: number | null;
  /** slots the proposed center is assumed to add (a typical center nearby); null = no slot data */
  pinSlots: number | null;
  /** candidates ÷ slots without / with the proposed center; null = no slots */
  utilizationBefore: number | null;
  utilizationAfter: number | null;
}

export class ReportAreaDto {
  @ApiProperty({ example: 'PROVINCE' })
  level: string;
  code: string;
  name: string;
  /** one per month in `months` (index 0 = the current month) */
  @ApiProperty({ type: () => [ReportPeriodDto] })
  months: ReportPeriodDto[];
  /** months 1-3 together */
  @ApiProperty({ type: () => ReportPeriodDto })
  next3: ReportPeriodDto;
}

/** The assessment deserts of the pin's province before / after the proposed center (city keys), for the report maps. */
export class ReportMapDto {
  provincePsgc: string;
  provinceName: string;
  desertsBefore: string[];
  desertsAfter: string[];
}

/** Extra figures stored with a saved proposal for its report. */
export class WhatIfReportDto {
  /** when the center and graduate data were last synced from the TESDA API (epoch seconds); null = never */
  dataUpdatedAt: number | null;
  /** Asia/Manila month starts (epoch seconds): the current month, then months 1-3 */
  months: number[];
  /** region, province and (Certification Office) nationwide, as far as the office may see */
  @ApiProperty({ type: () => [ReportAreaDto] })
  areas: ReportAreaDto[];
  @ApiPropertyOptional({ type: () => ReportMapDto, nullable: true })
  map: ReportMapDto | null;
}

export class ImprovedCityDto {
  key: string;
  name: string;
  flaggedBefore: number;
  flaggedAfter: number;
}

export class WhatIfResultDto {
  pin: WhatIfPinDto;
  /** candidates who get a slot because of the new center (nationwide) */
  newlyServed: number;
  /** candidates for whom the new center is the nearest reachable one */
  pinDemand: number;
  /** travel limit used for this result, minutes */
  limitMinutes: number;
  area: AreaDeltaDto;
  national: AreaDeltaDto;
  /**
   * The region and province where the pin was dropped, as far as the user's office may see them: CO gets both,
   * RO gets the province (the region is `area`), PO gets none (the province is `area`).
   */
  @ApiProperty({ type: () => [AreaDeltaDto] })
  placeAreas: AreaDeltaDto[];
  /** cities whose flagged candidates went down */
  @ApiProperty({ type: () => [ImprovedCityDto] })
  improvedCities: ImprovedCityDto[];
  /** saved proposals only: month-by-month figures, the data version and the desert maps for the report */
  @ApiPropertyOptional({ type: () => WhatIfReportDto })
  report?: WhatIfReportDto;
}

/** Where to open a new center: the area to look in (default: the user's home area), the travel limit, how many sites. */
export class RecommendQueryDto extends DashboardQueryDto {
  /** How many sites to suggest (default 3) */
  @ApiPropertyOptional({ minimum: 1, maximum: 5, default: 3 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  count = 3;
}

/** A qualification a recommended center should offer, from what the graduates of the provinces it would serve have. */
export class QualificationNeedDto {
  /** e.g. "Driving II" */
  qualification: string;
  /** candidates among those the site would serve who are likely to want it (an estimate) */
  estimatedCandidates: number;
  /** estimatedCandidates / the candidates served, 0 to 1 */
  share: number;
  /** existing centers in the provinces served that offer it (0 = nobody does) */
  centersOffering: number;
}

export class SiteRecommendationDto {
  /** 1 = the site that helps the most candidates */
  rank: number;
  /** the desert city or municipality the pin goes in */
  cityKey: string;
  cityName: string;
  provinceName: string | null;
  /** where to put the pin: on the nearest road when `onRoad`, otherwise a point inside the city */
  lat: number;
  lon: number;
  /** true when the point was moved onto a drivable road (OpenStreetMap, from the routing server) */
  onRoad: boolean;
  /** the road's name, when it has one */
  roadName: string | null;
  /** how far the point moved from the middle of the city to reach the road, metres */
  movedMeters: number;
  /** candidates who get a center in reach (all deserts the site covers, this one included) */
  newlyServed: number;
  /** assessment desert cities and municipalities this site closes */
  desertCitiesClosed: number;
  /** their names, most candidates first (up to 6) */
  desertNames: string[];
  /** the qualifications to offer first, most wanted first (empty when there is no graduate data for the area) */
  @ApiProperty({ type: () => [QualificationNeedDto] })
  topQualifications: QualificationNeedDto[];
}

export class RecommendationsDto {
  @ApiProperty({ type: 'object', additionalProperties: true })
  area: { level: string; code: string; name: string };
  limitMinutes: number;
  /** assessment deserts in the area now, and the candidates in them */
  desertCities: number;
  desertCandidates: number;
  @ApiProperty({ type: () => [SiteRecommendationDto] })
  sites: SiteRecommendationDto[];
  /** where the qualification suggestions come from, or null when they are not available */
  qualificationSource: string | null;
}

/** A point to move onto the nearest road (a pin dropped or dragged by hand). */
export class SnapQueryDto {
  @Type(() => Number)
  @IsLatitude()
  lat: number;

  @Type(() => Number)
  @IsLongitude()
  lon: number;

  /** The area the pin must stay inside (same meaning as in the what-if). Needs `code`. */
  @ApiPropertyOptional({ enum: [AreaLevel.REGION, AreaLevel.PROVINCE] })
  @IsOptional()
  @IsIn([AreaLevel.REGION, AreaLevel.PROVINCE])
  level?: AreaLevel;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  code?: string;
}

/** A proposed center's reach: the same pin and area as the what-if, and its travel limit. */
export class PinReachQueryDto extends SnapQueryDto {
  @ApiPropertyOptional({ minimum: MIN_LIMIT_MINUTES, maximum: MAX_LIMIT_MINUTES })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_LIMIT_MINUTES)
  @Max(MAX_LIMIT_MINUTES)
  limitMinutes?: number;
}

export class SnapResultDto {
  /** where the pin should go: on the nearest drivable road when `onRoad`, otherwise where it was dropped */
  lat: number;
  lon: number;
  onRoad: boolean;
  roadName: string | null;
  /** how far the pin moved to reach the road, metres */
  movedMeters: number;
}
