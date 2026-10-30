import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LonLat, OsrmClient, RawRoute, TableResult } from './osrm.client';

/**
 * Live road + ferry routing against the OSRM server, for the few interactive lookups that can't use the
 * precomputed matrix (a learner's own location, a center's reach, a what-if pin). Never throws: when
 * routing is off or the server is down it returns null and callers use the estimate model.
 */
@Injectable()
export class RoutingService {
  private readonly log = new Logger(RoutingService.name);
  private readonly client: OsrmClient | null;
  /** Second OSRM instance built with the foot profile (footpaths, steps, no motorways). */
  private readonly foot: OsrmClient | null;
  /** how callers name the model when they used live routing */
  readonly label = 'osrm(road+ferry, live; unrouted pairs: estimate)';

  constructor(config: ConfigService) {
    const on = config.get<string>('TRAVEL_MODEL', 'estimate') === 'osrm';
    const url = config.get<string>('OSRM_URL') || 'http://localhost:5001';
    const timeout = config.get<number>('OSRM_TIMEOUT_MS', 5000);
    // Interactive calls (finder, reach, what-if) retry once, quickly; the matrix build uses the client's patient defaults.
    const quick = { retries: 1, baseDelayMs: 150 };
    this.client = on ? new OsrmClient(url, timeout, undefined, 100, 'driving', quick) : null;
    const footUrl = config.get<string>('OSRM_FOOT_URL') || 'http://localhost:5002';
    this.foot = on ? new OsrmClient(footUrl, timeout, undefined, 100, 'walking', quick) : null;
  }

  private pick(profile: 'driving' | 'walking') {
    return profile === 'walking' ? this.foot : this.client;
  }

  get enabled() {
    return this.client !== null;
  }

  async table(sources: LonLat[], destinations: LonLat[], profile: 'driving' | 'walking' = 'driving'): Promise<TableResult | null> {
    const client = this.pick(profile);
    if (!client || !sources.length || !destinations.length) return null;
    try {
      return await client.table(sources, destinations);
    } catch (e) {
      this.log.warn(`live routing unavailable, using the estimate: ${(e as Error).message}`);
      return null;
    }
  }

  /** The nearest drivable road point to `p`. null when routing is off or unavailable, or no road is near. */
  async snapToRoad(p: LonLat): Promise<{ lon: number; lat: number; distanceM: number; road: string | null } | null> {
    if (!this.client) return null;
    try {
      return await this.client.nearest(p);
    } catch (e) {
      this.log.warn(`road snapping unavailable: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Route with geometry and maneuvers. 'none' = OSRM found no road or ferry connection;
   * null = routing is off or the server is unavailable.
   */
  async route(from: LonLat, to: LonLat, profile: 'driving' | 'walking' = 'driving'): Promise<RawRoute | 'none' | null> {
    const client = this.pick(profile);
    if (!client) return null;
    try {
      return (await client.route(from, to)) ?? 'none';
    } catch (e) {
      this.log.warn(`live routing unavailable: ${(e as Error).message}`);
      return null;
    }
  }
}
