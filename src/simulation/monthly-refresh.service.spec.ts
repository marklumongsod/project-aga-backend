import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import * as recovery from '../database/center-recovery.runner';
import { TesdaSyncService } from '../tesda/tesda-sync.service';
import { MonthlyRefreshService } from './monthly-refresh.service';
import { SimulationService } from './simulation.service';
import { OsrmClient } from './travel/osrm.client';
import { TravelMatrixService } from './travel/travel-matrix.service';

jest.mock('../database/center-recovery.runner');
const mocked = recovery as jest.Mocked<typeof recovery>;

const A = { id: 1, lat: 10, lon: 122 };
const B = { id: 2, lat: 11, lon: 123 };
const NEW = { id: 3, lat: 12, lon: 124 };

type Refresh = (client: OsrmClient, ids: number[]) => Promise<unknown>;

function setup(opts: { mode?: string; sync?: () => Promise<unknown>; refresh?: Refresh } = {}) {
  const log: string[] = [];
  let points = [A, B];
  const tesda = {
    sync: jest.fn(async () => {
      log.push('sync');
      if (opts.sync) return opts.sync();
      points = [A, B, NEW]; // TESDA added a center
      return { centers: 3 };
    }),
  };
  mocked.assessExcludedCenters.mockImplementation(async () => {
    log.push('quality');
    return { total: 3, analysed: 3, deliberate: [], verdicts: [] };
  });
  mocked.applyRecovery.mockImplementation(async () => []);
  const matrix = {
    mode: opts.mode ?? 'osrm',
    centerPoints: jest.fn(async () => points),
    routedCenterIds: jest.fn(async () => new Set([1, 2])),
    refreshCenters: jest.fn<Promise<unknown>, [OsrmClient, number[]]>(
      opts.refresh ??
        (async (_c, ids) => {
          log.push(`route:${ids.join(',')}`);
          return { centers: ids.length, pairs: 10, routed: 10, unrouted: 0, droppedRows: 0 };
        }),
    ),
  };
  const sim = { runAll: jest.fn(async () => void log.push('simulate')) };
  const svc = new MonthlyRefreshService(
    {} as DataSource,
    tesda as unknown as TesdaSyncService,
    matrix as unknown as TravelMatrixService,
    sim as unknown as SimulationService,
    { get: () => undefined } as unknown as ConfigService,
  );
  const logger = (svc as unknown as { logger: { log: () => void; error: () => void } }).logger;
  jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  return { svc, log, matrix, error };
}

describe('MonthlyRefreshService', () => {
  afterEach(() => jest.resetAllMocks());

  it('runs sync, data quality, routing of the changed centers only, then the simulation, in that order', async () => {
    const { svc, log } = setup();
    const r = await svc.run('test');
    expect(log).toEqual(['sync', 'quality', 'route:3', 'simulate']);
    expect(r).toEqual({ sync: 'done', recovered: [], routing: { centers: 1, routed: 10, unrouted: 0, droppedRows: 0 }, simulation: 'done' });
  });

  it('routes the centers the data-quality check put back', async () => {
    const { svc, log } = setup({ sync: async () => ({ skipped: 'unchanged', tesdaRunAt: 0 }) });
    mocked.applyRecovery.mockImplementation(async () => [7]);
    const points = [A, B, { id: 7, lat: 9, lon: 121 }];
    let call = 0;
    (svc as unknown as { matrix: { centerPoints: () => Promise<unknown> } }).matrix.centerPoints = async () => (call++ === 0 ? [A, B] : points);
    const r = await svc.run('test');
    expect(r.sync).toBe('skipped');
    expect(r.recovered).toEqual([7]);
    expect(log).toContain('route:7');
  });

  it('keeps going when the sync fails, and still simulates', async () => {
    const { svc, log, error } = setup({ sync: () => Promise.reject(new Error('TESDA down')) });
    const r = await svc.run('test');
    expect(r.sync).toBe('failed');
    expect(log).toEqual(['sync', 'quality', 'route:', 'simulate']);
    expect(error).toHaveBeenCalled();
  });

  it('does not route when the travel model is the estimate', async () => {
    const { svc, log, matrix } = setup({ mode: 'estimate' });
    const r = await svc.run('test');
    expect(matrix.refreshCenters).not.toHaveBeenCalled();
    expect(r.routing).toEqual({ skipped: expect.stringContaining('estimate') });
    expect(log).toEqual(['sync', 'quality', 'simulate']);
  });

  it('still simulates when OSRM is down; new centers use the estimate until next time', async () => {
    const { svc, log } = setup({ refresh: () => Promise.reject(new Error('Cannot reach OSRM')) });
    const r = await svc.run('test');
    expect(r.routing).toEqual({ skipped: 'Cannot reach OSRM' });
    expect(log).toEqual(['sync', 'quality', 'simulate']);
  });
});
