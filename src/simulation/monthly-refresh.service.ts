import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { applyRecovery, assessExcludedCenters } from '../database/center-recovery.runner';
import { TesdaSyncService } from '../tesda/tesda-sync.service';
import { SimulationService } from './simulation.service';
import { centersToReroute } from './travel/changed-centers';
import { OsrmClient } from './travel/osrm.client';
import { TravelMatrixService } from './travel/travel-matrix.service';

/** What each step of the monthly job did, for the log and the tests. */
export interface MonthlyRefreshResult {
  sync: 'done' | 'skipped' | 'failed';
  /** centers put back in the analysis by the data-quality check (null = the check failed) */
  recovered: number[] | null;
  /** centers routed again, or why routing was skipped */
  routing: { centers: number; routed: number; unrouted: number; droppedRows: number } | { skipped: string };
  simulation: 'done' | 'failed';
}

/**
 * The monthly job, one step after another, each feeding the next:
 *   1. TESDA sync          centers, qualifications, upcoming graduates
 *   2. data quality        put back centers left out for a data problem whose coordinates pass the checks (logged in
 *                          center_recovery_log; `npm run data:quality -- --revert` undoes it)
 *   3. travel times        route only the centers that are new to the analysis, moved, or have no travel times yet;
 *                          the rest of travel_times is kept (TRAVEL_MODEL=osrm only)
 *   4. simulation          deserts and flagged counts on the new data, inside the API so the what-if cache refreshes
 * A failing step is logged and the next one still runs on whatever is there: the last good data is never thrown away.
 * A full `npm run travel:build` is still the way to re-route everything after a new road map or a speed change.
 */
@Injectable()
export class MonthlyRefreshService {
  private readonly logger = new Logger(MonthlyRefreshService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly tesda: TesdaSyncService,
    private readonly matrix: TravelMatrixService,
    private readonly sim: SimulationService,
    private readonly config: ConfigService,
  ) {}

  /** The OSRM client for the batch step: patient timeouts and retries, like `npm run travel:build`. */
  protected osrmClient(): OsrmClient {
    return new OsrmClient(this.config.get<string>('OSRM_URL') || 'http://localhost:5001', 30_000);
  }

  async run(triggeredBy: string): Promise<MonthlyRefreshResult> {
    const before = await this.matrix.centerPoints();

    // 1. TESDA sync
    let sync: MonthlyRefreshResult['sync'] = 'done';
    try {
      const r = await this.tesda.sync(triggeredBy);
      if ('skipped' in r) sync = 'skipped';
    } catch (e) {
      sync = 'failed';
      this.logger.error(`TESDA sync failed, keeping the last synced data: ${(e as Error).message}`);
    }

    // 2. data quality, applied
    let recovered: number[] | null = null;
    try {
      const { verdicts } = await assessExcludedCenters(this.db);
      recovered = await applyRecovery(this.db, verdicts);
      const out = verdicts.length - recovered.length;
      this.logger.log(`data quality: ${recovered.length} centers put back in the analysis, ${out} still out (undo: npm run data:quality -- --revert)`);
    } catch (e) {
      this.logger.error(`data quality check failed, no center recovered: ${(e as Error).message}`);
    }

    // 3. travel times for the centers that changed
    let routing: MonthlyRefreshResult['routing'];
    if (this.matrix.mode !== 'osrm') {
      routing = { skipped: 'TRAVEL_MODEL is not osrm: the simulation uses the estimate' };
    } else {
      try {
        const ids = centersToReroute(before, await this.matrix.centerPoints(), await this.matrix.routedCenterIds());
        const r = await this.matrix.refreshCenters(this.osrmClient(), ids);
        routing = { centers: r.centers, routed: r.routed, unrouted: r.unrouted, droppedRows: r.droppedRows };
        this.logger.log(
          `travel times: ${r.centers} centers routed (${r.routed} pairs, ${r.unrouted} without a route use the estimate), ${r.droppedRows} rows of centers no longer in the analysis dropped`,
        );
      } catch (e) {
        routing = { skipped: (e as Error).message };
        this.logger.error(`travel times not refreshed, new centers use the estimate until the next run: ${(e as Error).message}`);
      }
    }

    // 4. simulation
    let simulation: MonthlyRefreshResult['simulation'] = 'done';
    try {
      await this.sim.runAll(triggeredBy);
    } catch (e) {
      simulation = 'failed';
      this.logger.error(`simulation after the monthly refresh failed: ${(e as Error).message}`, (e as Error).stack);
    }
    return { sync, recovered, routing, simulation };
  }
}
