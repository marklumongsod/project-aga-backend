import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/auth.decorators';
import { DashboardQueryDto, OverviewDto } from './dashboard.dto';
import { DashboardService } from './dashboard.service';

/** CO / RO / PO dashboards. Each user is limited to their own area (see AreaScopeService). */
@ApiTags('dashboard')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /** Overview: KPIs, Top 5 / Top 3, and all child areas. */
  @Get('overview')
  overview(@CurrentUser() user: AuthUser, @Query() q: DashboardQueryDto): Promise<OverviewDto> {
    return this.dashboard.overview(user, q);
  }

  /** GeoJSON choropleth of the child areas, colored by the team legend. */
  @Get('map')
  map(@CurrentUser() user: AuthUser, @Query() q: DashboardQueryDto) {
    return this.dashboard.map(user, q);
  }

  /** Centers in the area with predicted candidates (TESDA only). */
  @Get('centers')
  centers(@CurrentUser() user: AuthUser, @Query() q: DashboardQueryDto) {
    return this.dashboard.centers(user, q);
  }
}
