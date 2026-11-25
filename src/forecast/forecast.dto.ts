import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

/** Forecast levels. The model has no city level; centers are the smallest unit. */
export enum ForecastLevelDto {
  NATIONAL = 'NATIONAL',
  REGION = 'REGION',
  PROVINCE = 'PROVINCE',
  CENTER = 'CENTER',
}

export class ForecastQueryDto {
  /** Omit to open the user's home area (PH for CO, own region for RO, own province for PO). */
  @ApiPropertyOptional({ enum: ForecastLevelDto })
  @IsOptional()
  @IsEnum(ForecastLevelDto)
  level?: ForecastLevelDto;

  /** Region/province PSGC, or the assessment center id for level=CENTER. */
  @ApiPropertyOptional({ description: 'PSGC for region/province; center id for CENTER' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  code?: string;
}

export class ForecastPointDto {
  @ApiProperty({ example: '2026-11' })
  targetMonth: string;

  @ApiProperty({ example: 1 })
  horizon: number;

  @ApiProperty({ example: 188772, description: 'forecast_real: full-population estimate' })
  candidates: number;
}

export class ForecastAreaDto {
  @ApiProperty({ enum: ForecastLevelDto })
  level: ForecastLevelDto;

  @ApiProperty({ example: '0600000000' })
  code: string;

  @ApiProperty({ example: 'Region VI (Western Visayas)' })
  name: string;

  @ApiProperty({ example: true, description: 'false when there is no model forecast for this area' })
  available: boolean;

  @ApiProperty({ type: () => [ForecastPointDto] })
  forecast: ForecastPointDto[];

  @ApiPropertyOptional({ nullable: true, example: null })
  note?: string | null;
}

export class ForecastAccuracyDto {
  @ApiPropertyOptional({ nullable: true, description: 'WAPE, next month' })
  wape1Month: number | null;

  @ApiPropertyOptional({ nullable: true, description: 'WAPE, 1-6 months ahead' })
  wape1To6: number | null;

  @ApiPropertyOptional({ nullable: true, description: 'WAPE, 6 months ahead' })
  wape6Months: number | null;

  @ApiPropertyOptional({ nullable: true, description: 'positive = forecasts run high' })
  bias: number | null;
}

export class ForecastRunDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: '2026-10' })
  forecastMonth: string;

  @ApiProperty({ description: 'epoch seconds' })
  generatedAt: number;

  @ApiProperty({ description: 'epoch seconds' })
  importedAt: number;

  @ApiProperty({ example: 'lightgbm-6b4627d435e9' })
  modelVersion: string;

  @ApiProperty({ example: 0.2 })
  sampleRate: number;

  @ApiProperty({ example: false, description: 'true when a newer monthly run should already exist' })
  stale: boolean;
}

export class ForecastCoverageDto {
  @ApiProperty({ description: 'child areas or centers in the area' })
  total: number;

  @ApiProperty({ description: 'how many have a forecast row' })
  withForecast: number;
}

export class ForecastResponseDto {
  @ApiProperty({ type: () => ForecastRunDto })
  run: ForecastRunDto;

  @ApiPropertyOptional({ type: () => ForecastAccuracyDto, nullable: true })
  accuracy: ForecastAccuracyDto | null;

  @ApiProperty({ type: () => ForecastAreaDto })
  area: ForecastAreaDto;

  @ApiProperty({ type: () => [ForecastAreaDto] })
  children: ForecastAreaDto[];

  @ApiPropertyOptional({ type: () => ForecastCoverageDto, nullable: true })
  coverage: ForecastCoverageDto | null;
}

export class ForecastMetaDto {
  @ApiPropertyOptional({ type: () => ForecastRunDto, nullable: true })
  latest: ForecastRunDto | null;

  @ApiPropertyOptional({ nullable: true, example: 'targets October 2023 to August 2026' })
  trainedOn: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'test accuracy per level, from config.json' })
  accuracy: Record<string, ForecastAccuracyDto> | null;
}
