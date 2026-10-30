import { Module } from '@nestjs/common';
import { TesdaModule } from '../tesda/tesda.module';
import { DemandService } from './demand.service';
import { SimulationController } from './simulation.controller';
import { SimulationScheduler } from './simulation.scheduler';
import { SimulationService } from './simulation.service';
import { MatrixTravelTimeModel } from './travel/matrix-travel-time.model';
import { RoutingService } from './travel/routing.service';
import { TravelMatrixService } from './travel/travel-matrix.service';
import { EstimatedTravelTimeModel, TRAVEL_TIME_MODEL } from './travel/travel-time.model';

@Module({
  imports: [TesdaModule],
  controllers: [SimulationController],
  providers: [
    DemandService,
    SimulationService,
    SimulationScheduler,
    // The estimate is the fallback; the OSRM matrix (TRAVEL_MODEL=osrm) is loaded into it by TravelMatrixService.
    { provide: TRAVEL_TIME_MODEL, useFactory: () => new MatrixTravelTimeModel(new EstimatedTravelTimeModel(1.35, 35, 90)) },
    RoutingService,
    TravelMatrixService,
  ],
  exports: [SimulationService, TRAVEL_TIME_MODEL, RoutingService, TravelMatrixService],
})
export class SimulationModule {}
