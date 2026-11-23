import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/auth.decorators';
import { ForecastMetaDto, ForecastQueryDto, ForecastResponseDto } from './forecast.dto';
import { ForecastService } from './forecast.service';

/** Monthly assessment-candidate forecasts, scoped like the dashboard (CO / RO / PO). */
@ApiTags('forecasts')
@ApiBearerAuth()
@Controller('forecasts')
export class ForecastController {
  constructor(private readonly forecasts: ForecastService) {}

  /** The latest imported run, model version, accuracy and whether it is stale. */
  @Get('meta')
  meta(): Promise<ForecastMetaDto> {
    return this.forecasts.meta();
  }

  /** Six-month forecast for the user's home area, or for the requested region/province/center. */
  @Get()
  get(@CurrentUser() user: AuthUser, @Query() q: ForecastQueryDto): Promise<ForecastResponseDto> {
    return this.forecasts.get(user, q);
  }
}
