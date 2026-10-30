import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/auth.decorators';
import { CenterQueryDto } from './centers.dto';
import { CentersService } from './centers.service';

@ApiTags('centers')
@ApiBearerAuth()
@Controller('centers')
export class CentersController {
  constructor(private readonly centers: CentersService) {}

  /** Center card (hover/click): details, qualifications and predicted candidates. */
  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Query() q: CenterQueryDto) {
    return this.centers.detail(user, id, q.limitMinutes);
  }

  /** Area reachable within the travel limit (click a center to highlight it). */
  @Get(':id/reach')
  reach(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Query() q: CenterQueryDto) {
    return this.centers.reach(user, id, q.limitMinutes);
  }

  /** True travel-time polygons (30 / 60 / 90 minutes) around a center, from OSRM road and ferry routing. */
  @Get(':id/isochrone')
  isochrone(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Query() q: CenterQueryDto) {
    return this.centers.isochrone(user, id, q.limitMinutes);
  }
}
