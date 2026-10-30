import { Module } from '@nestjs/common';
import { TesdaSyncService } from './tesda-sync.service';

@Module({
  providers: [TesdaSyncService],
  exports: [TesdaSyncService],
})
export class TesdaModule {}
