import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/auth.decorators';
import { RecommendationsDto, RecommendQueryDto, SnapQueryDto, SnapResultDto, WhatIfDto, WhatIfResultDto } from './simulation.dto';
import { SimulationService } from './simulation.service';

@ApiTags('simulation')
@ApiBearerAuth()
@Controller('simulation')
export class SimulationController {
  constructor(private readonly sim: SimulationService) {}

  /**
   * Where to open a new center: the sites that close the most assessment deserts in the area (default: the user's
   * home area), best first. Use a site's lat/lon with the what-if for the exact before and after.
   */
  @Get('recommendations')
  recommendations(@CurrentUser() user: AuthUser, @Query() q: RecommendQueryDto): Promise<RecommendationsDto> {
    return this.sim.recommend(user, q);
  }

  /** Move a pin onto the nearest road. The planner calls this every time a pin is dropped or dragged by hand. */
  @Get('snap')
  snap(@CurrentUser() user: AuthUser, @Query() q: SnapQueryDto): Promise<SnapResultDto> {
    return this.sim.snapPin(user, q);
  }

  /**
   * Drag and drop a proposed assessment center. Re-runs the check with the new
   * center and returns the before/after for the user's area and nationally. Nothing is stored.
   */
  @Post('what-if')
  @HttpCode(200)
  whatIf(@CurrentUser() user: AuthUser, @Body() dto: WhatIfDto): Promise<WhatIfResultDto> {
    return this.sim.whatIf(user, dto);
  }
}
