import { Module } from '@nestjs/common';
import { ForecastImportService } from './forecast-import.service';
import { ForecastController } from './forecast.controller';
import { ForecastService } from './forecast.service';

@Module({
  controllers: [ForecastController],
  providers: [ForecastService, ForecastImportService],
  exports: [ForecastService, ForecastImportService],
})
export class ForecastModule {}
