import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/auth.decorators';
import { NearestCentersDto, PublicStatsDto, RouteDto, RouteResultDto, SearchDto } from './public.dto';
import { PublicService } from './public.service';

/** Public learner finder - no sign-in, rate limited, no learner or congestion data. */
@ApiTags('public')
@Public()
@Controller('public')
export class PublicController {
  constructor(private readonly svc: PublicService) {}

  /** Headline numbers for the finder page: centers on the map and qualifications they assess */
  @Get('stats')
  stats(): Promise<PublicStatsDto> {
    return this.svc.stats();
  }

  /** Search box: "Your city or municipality" */
  @Get('places')
  places(@Query() { q }: SearchDto) {
    return this.svc.places(q);
  }

  /** Qualification filter options (e.g. Cookery NC II) */
  @Get('qualifications')
  qualifications(@Query('q') q?: string) {
    return this.svc.qualifications(q?.trim().slice(0, 80) || undefined);
  }

  /** Nearest assessment centers from the learner's location, filtered by qualification and area */
  @Get('centers/nearest')
  nearest(@Query() dto: NearestCentersDto) {
    return this.svc.nearest(dto);
  }

  /** Turn-by-turn directions (road and ferry) from the learner's location to one center, with the route line for the map */
  @Get('route')
  route(@Query() dto: RouteDto): Promise<RouteResultDto> {
    return this.svc.route(dto);
  }
}
