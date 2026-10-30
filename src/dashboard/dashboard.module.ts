import { Module } from '@nestjs/common';
import { SimulationModule } from '../simulation/simulation.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [SimulationModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
