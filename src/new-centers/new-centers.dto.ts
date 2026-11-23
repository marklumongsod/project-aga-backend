import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class NewCenterPredictDto {
  @ApiPropertyOptional({ example: 'Planned center A' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  /** Pin latitude; must be inside the selected province and the user's area. */
  @ApiProperty({ example: 10.6765 })
  @IsLatitude()
  lat: number;

  @ApiProperty({ example: 122.9509 })
  @IsLongitude()
  lon: number;

  /** Province PSGC where the center will open. */
  @ApiProperty({ example: '0604500000' })
  @IsString()
  @Matches(/^\d{10}$/, { message: 'provincePsgc must be a 10-digit PSGC' })
  provincePsgc: string;

  /** Optional backend city key. The model uses it when a raw CityId mapping is available. */
  @ApiPropertyOptional({ example: '0604501000' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  cityKey?: string;

  /** Qualification keys from GET /dashboard/qualifications, e.g. "cookery ii". */
  @ApiProperty({ type: [String], example: ['cookery ii', 'bread and pastry production ii'] })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  qualificationKeys: string[];

  /** Month the center opens (accreditation month), YYYY-MM. */
  @ApiProperty({ example: '2026-11' })
  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: 'accreditationMonth must look like 2026-11' })
  accreditationMonth: string;

  @ApiPropertyOptional({ example: 2 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  centerType?: number;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  centerClass?: number;
}

export class NewCenterMonthlyDto {
  @ApiProperty({ example: 1 })
  month: number;

  @ApiProperty({ example: '2026-11' })
  targetMonth: string;

  @ApiProperty({ example: 1.2, description: 'expected candidates, full-population estimate' })
  expected: number;
}

export class NewCenterPredictionDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'new-center-a3aae93e98af' })
  modelVersion: string;

  @ApiProperty({ example: '2026-10' })
  lastMonth: string;

  @ApiProperty({ example: '2026-11' })
  latestAccreditationMonth: string;

  @ApiProperty({ example: 0.293 })
  chanceAnyCandidates: number;

  @ApiProperty({ example: 94 })
  firstYearExpected: number;

  @ApiProperty({ type: () => [NewCenterMonthlyDto] })
  monthly: NewCenterMonthlyDto[];

  @ApiPropertyOptional({ nullable: true, description: 'model test accuracy from config.json' })
  accuracy?: Record<string, unknown> | null;
}

export class NewCenterMetaDto {
  @ApiProperty({ example: '2026-10' })
  lastMonth: string;

  @ApiProperty({ example: '2026-11' })
  latestAccreditationMonth: string;

  @ApiProperty({ example: 'new-center-a3aae93e98af' })
  modelVersion: string;

  @ApiProperty({ example: 0.2 })
  sampleRate: number;

  @ApiPropertyOptional({ nullable: true })
  trainedOn: string | null;

  @ApiPropertyOptional({ nullable: true })
  testAccuracy: Record<string, unknown> | null;

  @ApiPropertyOptional({ nullable: true })
  versions: Record<string, unknown> | null;

  @ApiProperty({ example: 8.1 })
  loadSeconds: number;
}
