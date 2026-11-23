import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/auth.decorators';
import { NewCenterMetaDto, NewCenterPredictDto, NewCenterPredictionDto } from './new-centers.dto';
import { NewCentersService } from './new-centers.service';

/** New Assessment Center Model: first-year estimate for a planned center. Scoped like the what-if. */
@ApiTags('new-centers')
@ApiBearerAuth()
@Controller('new-centers')
export class NewCentersController {
  constructor(private readonly newCenters: NewCentersService) {}

  /** The model's raw-data cutoff, latest allowed accreditation month, version and test accuracy. */
  @Get('meta')
  meta(): Promise<NewCenterMetaDto> {
    return this.newCenters.meta();
  }

  /** Estimate a planned center's first 12 months and chance of getting any candidates. */
  @Post('predict')
  @HttpCode(200)
  predict(@CurrentUser() user: AuthUser, @Body() dto: NewCenterPredictDto): Promise<NewCenterPredictionDto> {
    return this.newCenters.predict(user, dto);
  }
}
