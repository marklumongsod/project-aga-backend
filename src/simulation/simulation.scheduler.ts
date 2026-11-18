import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { MonthlyRefreshService } from './monthly-refresh.service';
import { SimulationService } from './simulation.service';

/**
 * Two schedules (Asia/Manila):
 *   - TESDA_SYNC_CRON (monthly by default): the monthly refresh (MonthlyRefreshService): TESDA sync, data-quality
 *     recovery, travel times for the centers that changed, then a simulation. TESDA recalculates around 01:30
 *     Manila, so the default runs at 01:45 on the 1st.
 *   - SIM_CRON (daily): run the simulation on whatever was last synced.
 * Both go through one queue, so they never overlap: on a sync day the daily simulation waits for the monthly
 * refresh and uses its data. A failed step keeps the last good data; the next step still runs.
 */
@Injectable()
export class SimulationScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(SimulationScheduler.name);
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly sim: SimulationService,
    private readonly monthly: MonthlyRefreshService,
    private readonly registry: SchedulerRegistry,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap() {
    if (this.config.get('NODE_ENV') === 'test') return;
    const syncCron = this.config.get<string>('TESDA_SYNC_CRON', '45 1 1 * *');
    const simCron = this.config.get<string>('SIM_CRON', '0 2 * * *');
    this.schedule('monthly-refresh', syncCron, () => this.runSync());
    this.schedule('daily-simulation', simCron, () => this.runSimulation());
    this.logger.log(`monthly refresh (TESDA sync, data quality, travel times, simulation) scheduled: "${syncCron}"; simulation scheduled: "${simCron}" (Asia/Manila)`);
  }

  /** Runs a task after every task queued before it; a failing task doesn't block the next. */
  enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task, task);
    return this.queue;
  }

  runSync(): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.monthly.run('scheduler');
      } catch (e) {
        this.logger.error(`monthly refresh failed: ${(e as Error).message}`, (e as Error).stack);
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
