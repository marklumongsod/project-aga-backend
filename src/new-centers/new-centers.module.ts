import { Module } from '@nestjs/common';
import { NewCenterMappingService } from './new-center-mapping.service';
import { NewCentersController } from './new-centers.controller';
import { NewCentersService } from './new-centers.service';

@Module({
  controllers: [NewCentersController],
  providers: [NewCentersService, NewCenterMappingService],
  exports: [NewCentersService, NewCenterMappingService],
})
export class NewCentersModule {}
