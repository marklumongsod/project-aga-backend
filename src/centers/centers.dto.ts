import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { MAX_LIMIT_MINUTES, MIN_LIMIT_MINUTES } from '../simulation/limits';

export class CenterQueryDto {
  /** Travel limit in minutes (default: the configured 90) */
  @ApiPropertyOptional({ minimum: MIN_LIMIT_MINUTES, maximum: MAX_LIMIT_MINUTES })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_LIMIT_MINUTES)
  @Max(MAX_LIMIT_MINUTES)
  limitMinutes?: number;

  /** Calendar quarter for the capacity view, e.g. 2026-Q4. Defaults to the current quarter. */
  @ApiPropertyOptional({ example: '2026-Q4' })
  @IsOptional()
  @Matches(/^\d{4}-Q[1-4]$/, { message: 'quarter must look like 2026-Q4' })
  quarter?: string;
}
