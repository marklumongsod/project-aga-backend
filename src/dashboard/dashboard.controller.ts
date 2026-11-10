import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/auth.decorators';
import { DashboardQueryDto, OverviewDto, QualificationOptionDto } from './dashboard.dto';
import { DashboardService } from './dashboard.service';

/** CO / RO / PO dashboards. Each user is limited to their own area (see AreaScopeService). */
@ApiTags('dashboard')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /** The qualifications that have upcoming graduates (the dashboard's Qualification filter). */
  @Get('qualifications')
  qualifications(): Promise<QualificationOptionDto[]> {
    return this.dashboard.qualifications();
  }

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
  /** The assessment desert cities inside the area, with shapes (the map paints only these red). */
  @Get('deserts')
  deserts(@CurrentUser() user: AuthUser, @Query() q: DashboardQueryDto) {
    return this.dashboard.deserts(user, q);
  }

  /** Every city in the area as a point with its candidates and flagged count (the map's heat layer). */
  @Get('heat')
  heat(@CurrentUser() user: AuthUser, @Query() q: DashboardQueryDto) {
    return this.dashboard.heat(user, q);
  }

  @Get('centers')
  centers(@CurrentUser() user: AuthUser, @Query() q: DashboardQueryDto) {
    return this.dashboard.centers(user, q);
  }
}
