import { Module } from '@nestjs/common';
import { SimulationModule } from '../simulation/simulation.module';
import { CentersController } from './centers.controller';
import { CentersService } from './centers.service';

@Module({
  imports: [SimulationModule],
  controllers: [CentersController],
  providers: [CentersService],
})
export class CentersModule {}
