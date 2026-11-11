import { ApiProperty } from '@nestjs/swagger';
import { LegendBandDto } from '../dashboard/dashboard.dto';
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class SearchDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  q: string;
}

/** Public learner finder. Give your location (lat/lon from "Use my location") or a city key from /public/places. */
export class NearestCentersDto {
  @ValidateIf((o: NearestCentersDto) => !o.cityKey)
  @Type(() => Number)
  @IsLatitude()
  lat?: number;

  @ValidateIf((o: NearestCentersDto) => !o.cityKey)
  @Type(() => Number)
  @IsLongitude()
  lon?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  cityKey?: string;

  /**
   * Only centers accredited for this qualification, by its `label` from /public/qualifications ("Cookery NC II");
   * the TESDA API's own name ("Cookery II") also works.
   */
  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  qualification?: string;

  /** Only centers in this region / province (PSGC) */
  @IsOptional()
  @IsString()
  @Length(10, 10)
  regionPsgc?: string;

  @IsOptional()
  @IsString()
  @Length(10, 10)
  provincePsgc?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit = 5;
}

/** Turn-by-turn directions from a point to one assessment center. */
export class RouteDto {
  @Type(() => Number)
  @IsLatitude()
  lat: number;

  @Type(() => Number)
  @IsLongitude()
  lon: number;

  /** An assessment center id from /public/centers/nearest */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  centerId: number;
}

export class LineStringDto {
  type: 'LineString';
  /** [lon, lat] pairs */
  coordinates: number[][];
}

export class RouteStepDto {
  /** "Turn left onto Rizal Street" */
  instruction: string;
  distanceM: number;
  minutes: number;
  mode: 'driving' | 'ferry' | 'walking';
  /** where the maneuver happens: [lon, lat] */
  location: number[];
  type: string;
  modifier: string | null;
}

export class RouteCenterDto {
  id: number;
  name: string;
  address: string | null;
  phone: string | null;
  lat: number;
  lon: number;
}

export class SnapPointDto {
  lon: number;
  lat: number;
  /** metres from the requested point to this spot on the road */
  distanceM: number;
}

export class RouteSnapDto {
  start: SnapPointDto;
  end: SnapPointDto;
}

export class RouteResultDto {
  /** walking when the center is within 500 m (a straight-line guide, no roads), otherwise driving (road + ferry) */
  mode: 'driving' | 'walking';
  from: { lat: number; lon: number };
  center: RouteCenterDto;
  km: number;
  minutes: number;
  /** true when the route includes a ferry crossing */
  hasFerry: boolean;
  geometry: LineStringDto;
  /** the route starts and ends on the nearest road; these say how far that is from your point and from the center */
  snapped: RouteSnapDto;
  /** false when the center's map position was filled in by a geocoder rather than validated, so it may be off */
  locationVerified: boolean;
  steps: RouteStepDto[];
  travelModel: string;
}

/** Headline numbers for the public finder page. Counts of centers and qualifications only: no learner or flagged figures. */
export class PublicStatsDto {
  /** assessment centers on the map (listed by TESDA and placed) */
  centers: number;
  /** distinct qualifications at least one of those centers can assess */
  qualifications: number;
  /** assessment desert levels: labels and map colours only (for the About page legend) */
  @ApiProperty({ type: () => [LegendBandDto] })
  desertLegend: ReadonlyArray<LegendBandDto>;
}
