import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { TesdaSyncService } from '../tesda/tesda-sync.service';
import { SimulationScheduler } from './simulation.scheduler';
import { SimulationService } from './simulation.service';

const tick = () => new Promise((r) => setImmediate(r));

function setup(syncImpl: () => Promise<unknown>) {
  const log: string[] = [];
  let finishSync!: () => void;
  const tesda = {
    sync: jest.fn(() => {
      log.push('sync:start');
      return new Promise<void>((resolve) => (finishSync = resolve))
        .then(syncImpl)
        .finally(() => log.push('sync:end'));
    }),
  };
  const sim = { runAll: jest.fn(async () => void log.push('simulate')) };
  const scheduler = new SimulationScheduler(
    sim as unknown as SimulationService,
    tesda as unknown as TesdaSyncService,
    {} as SchedulerRegistry,
    {} as ConfigService,
  );
  return { scheduler, log, finish: () => finishSync() };
}

describe('SimulationScheduler queue', () => {
  it('runs a simulation fired during a sync only after the sync finishes', async () => {
    const { scheduler, log, finish } = setup(async () => undefined);
    const sync = scheduler.runSync();
    const simulate = scheduler.runSimulation();
    await tick();
    expect(log).toEqual(['sync:start']);
    finish();
    await Promise.all([sync, simulate]);
    expect(log).toEqual(['sync:start', 'sync:end', 'simulate']);
  });

  it('still simulates when the sync fails', async () => {
    const { scheduler, log, finish } = setup(() => Promise.reject(new Error('TESDA down')));
    jest.spyOn((scheduler as unknown as { logger: { error: () => void } }).logger, 'error').mockImplementation(() => undefined);
    const sync = scheduler.runSync();
    const simulate = scheduler.runSimulation();
    await tick();
    finish();
    await Promise.all([sync, simulate]);
    expect(log).toEqual(['sync:start', 'sync:end', 'simulate']);
  });
});
