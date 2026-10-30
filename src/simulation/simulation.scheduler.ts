import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { TesdaSyncService } from '../tesda/tesda-sync.service';
import { SimulationService } from './simulation.service';

/**
 * Daily refresh ("Feature: per day updates"). Schedule comes from SIM_CRON (Asia/Manila).
 * Centers are pulled from the TESDA API first (TESDA recalculates around 01:30 Manila); if that fails the
 * simulation still runs on the centers of the last good sync.
 */
@Injectable()
export class SimulationScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(SimulationScheduler.name);

  constructor(
    private readonly sim: SimulationService,
    private readonly tesda: TesdaSyncService,
    private readonly registry: SchedulerRegistry,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap() {
    if (this.config.get('NODE_ENV') === 'test') return;
    const cron = this.config.get<string>('SIM_CRON', '0 2 * * *');
    const job = CronJob.from({
      cronTime: cron,
      timeZone: 'Asia/Manila',
      onTick: () => {
        this.tesda
          .sync('scheduler')
          .catch((e: Error) => this.logger.error(`TESDA sync failed, simulating on the last synced centers: ${e.message}`))
          .then(() => this.sim.runAll('scheduler'))
          .catch((e: Error) => this.logger.error(`scheduled simulation failed: ${e.message}`, e.stack));
      },
    });
    this.registry.addCronJob('daily-simulation', job);
    job.start();
    this.logger.log(`daily TESDA sync + simulation scheduled: "${cron}" Asia/Manila`);
  }
}
