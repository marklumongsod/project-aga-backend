/**
 * Reach and deserts (pure TypeScript, no I/O - unit tested).
 *
 *   For each city (a group of candidates):
 *     list the centers it can reach: those whose travel time (by road and ferry) is within LIMIT minutes
 *     - at least one center  -> the candidates are served
 *     - no center            -> the candidates are FLAGGED, and the city is an assessment desert
 *
 *   There is no capacity model: slots are not counted, so a flagged candidate is one with no center in reach.
 *   flagged share = flagged / candidates
 *   predicted candidates of a center = candidates whose nearest reachable center it is
 */
import { haversineKm } from '../../common/geo/haversine';
import { TravelOrigin, TravelTimeModel } from '../travel/travel-time.model';

export interface SimCenter {
  id: number;
  lat: number;
  lon: number;
  islandId: number | null;
}

export interface SimGroup {
  /** city key */
  key: string;
  lat: number;
  lon: number;
  islandId: number | null;
  count: number;
}

export interface EngineOptions {
  limitMinutes: number;
  /**
   * How far (straight line) to look for centers. Only a search bound that is large enough that nothing reachable in
   * `limitMinutes` can lie beyond it; it never decides reach (travel time does).
   */
  searchKm: number;
  travel: TravelTimeModel;
}

export interface GroupResult {
  key: string;
  count: number;
  /** candidates with no center in reach: all of them in a desert city, none otherwise */
  flagged: number;
  /** fastest trip to any center (minutes), null when none within the limits */
  nearestMinutes: number | null;
}

export interface CenterResult {
  id: number;
  /** candidates whose first (nearest) reachable center is this one - "predicted candidates" */
  demand: number;
  /**
   * candidates in every city this center can reach within the travel limit (a city counts for every center it can
   * reach, so reach values overlap; they are not a partition of the candidates)
   */
  reach: number;
}

export interface EngineResult {
  groups: Map<string, GroupResult>;
  centers: Map<number, CenterResult>;
  totals: { candidates: number; flagged: number };
}

interface Reach {
  center: SimCenter;
  minutes: number;
}

const GRID = 0.5; // degrees per spatial bucket

export class UtilizationEngine {
  private readonly grid = new Map<string, SimCenter[]>();

  constructor(
    private readonly centers: SimCenter[],
    private readonly opts: EngineOptions,
  ) {
    for (const c of centers) {
      const k = this.cell(c.lat, c.lon);
      const list = this.grid.get(k);
      if (list) list.push(c);
      else this.grid.set(k, [c]);
    }
  }

  private cell(lat: number, lon: number): string {
    return `${Math.floor(lat / GRID)}:${Math.floor(lon / GRID)}`;
  }

  /** The centers within `limitMinutes` of travel from one origin, nearest first. */
  reachable(from: TravelOrigin): Reach[] {
    const { lat, lon } = from;
    const span = Math.ceil(this.opts.searchKm / 111 / GRID) + 1;
    const cy = Math.floor(lat / GRID);
    const cx = Math.floor(lon / GRID);
    const out: Reach[] = [];
    for (let y = cy - span; y <= cy + span; y++) {
      for (let x = cx - span; x <= cx + span; x++) {
        for (const c of this.grid.get(`${y}:${x}`) ?? []) {
          const km = haversineKm(lat, lon, c.lat, c.lon);
          if (km > this.opts.searchKm) continue; // search bound only, not a reach rule
          const minutes = this.opts.travel.minutes(from, c, km);
          if (minutes > this.opts.limitMinutes) continue; // the reach rule
          out.push({ center: c, minutes });
        }
      }
    }
    return out.sort((a, b) => a.minutes - b.minutes || a.center.id - b.center.id);
  }

  run(groups: SimGroup[]): EngineResult {
    const demand = new Map<number, number>(this.centers.map((c) => [c.id, 0]));
    const reachCount = new Map<number, number>(this.centers.map((c) => [c.id, 0]));
    const results = new Map<string, GroupResult>();
    let candidates = 0;
    let flagged = 0;

    for (const g of groups) {
      const reach = this.reachable({ key: g.key, lat: g.lat, lon: g.lon, islandId: g.islandId });
      const none = reach.length === 0;
      results.set(g.key, { key: g.key, count: g.count, flagged: none ? g.count : 0, nearestMinutes: reach[0]?.minutes ?? null });
      if (reach[0]) demand.set(reach[0].center.id, (demand.get(reach[0].center.id) ?? 0) + g.count);
      for (const hit of reach) reachCount.set(hit.center.id, (reachCount.get(hit.center.id) ?? 0) + g.count);
      candidates += g.count;
      if (none) flagged += g.count;
    }

    const centers = new Map<number, CenterResult>(
      this.centers.map((c) => [c.id, { id: c.id, demand: demand.get(c.id)!, reach: reachCount.get(c.id)! }]),
    );
    return { groups: results, centers, totals: { candidates, flagged } };
  }
}
