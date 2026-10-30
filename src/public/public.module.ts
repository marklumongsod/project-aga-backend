import { Module } from '@nestjs/common';
import { SimulationModule } from '../simulation/simulation.module';
import { GeoController } from './geo.controller';
import { PublicController } from './public.controller';
import { PublicService } from './public.service';

@Module({
  imports: [SimulationModule],
  controllers: [PublicController, GeoController],
  providers: [PublicService],
})
export class PublicModule {}
