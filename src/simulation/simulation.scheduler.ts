import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { TesdaSyncService } from '../tesda/tesda-sync.service';
import { SimulationService } from './simulation.service';

/**
 * Two schedules (Asia/Manila):
 *   - TESDA_SYNC_CRON (monthly by default): pull centers, qualifications and upcoming graduates from the TESDA API.
 *     TESDA recalculates around 01:30 Manila, so the default runs at 01:45 on the 1st.
 *   - SIM_CRON (daily): run the simulation on whatever was last synced.
 * Both go through one queue, so they never overlap: on a sync day the simulation waits for the sync and uses its
 * data. A failed sync keeps the last good data; the simulation still runs.
 */
@Injectable()
export class SimulationScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(SimulationScheduler.name);
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly sim: SimulationService,
    private readonly tesda: TesdaSyncService,
    private readonly registry: SchedulerRegistry,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap() {
    if (this.config.get('NODE_ENV') === 'test') return;
    const syncCron = this.config.get<string>('TESDA_SYNC_CRON', '45 1 1 * *');
    const simCron = this.config.get<string>('SIM_CRON', '0 2 * * *');
    this.schedule('tesda-sync', syncCron, () => this.runSync());
    this.schedule('daily-simulation', simCron, () => this.runSimulation());
    this.logger.log(`TESDA sync scheduled: "${syncCron}"; simulation scheduled: "${simCron}" (Asia/Manila)`);
  }

  /** Runs a task after every task queued before it; a failing task doesn't block the next. */
  enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task, task);
    return this.queue;
  }

  runSync(): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.tesda.sync('scheduler');
      } catch (e) {
        this.logger.error(`TESDA sync failed, keeping the last synced data: ${(e as Error).message}`);
      }
    });
  }

  runSimulation(): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.sim.runAll('scheduler');
      } catch (e) {
        this.logger.error(`scheduled simulation failed: ${(e as Error).message}`, (e as Error).stack);
      }
    });
  }

  private schedule(name: string, cronTime: string, onTick: () => Promise<void>) {
    const job = CronJob.from({ cronTime, timeZone: 'Asia/Manila', onTick: () => void onTick() });
    this.registry.addCronJob(name, job);
    job.start();
  }
}
