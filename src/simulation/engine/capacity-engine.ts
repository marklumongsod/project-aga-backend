/**
 * Capacity-aware assignment (pure, no I/O).
 *
 * For one qualification, candidates are processed city by city in a deterministic order. For each city, every center
 * it can reach within the travel limit is considered nearest first. The nearest center with an open slot receives the
 * candidates' demand (whether or not it can take them all); the candidates are then placed into open slots, overflowing
 * to the next reachable center. Anyone left is flagged.
 *
 * Utilization is demand / slots and can exceed 100%: more candidates want the center than it can serve.
 * Assigned is always at most the center's slots.
 */
import { EngineOptions, SimCenter, SimGroup, UtilizationEngine } from './utilization-engine';

export interface CapacityCenter extends SimCenter {
  /** slots for this center + qualification + quarter */
  slots: number;
}

export interface CapacityGroupResult {
  key: string;
  count: number;
  assigned: number;
  flagged: number;
  /** fastest reachable center (regardless of slots), null when none is in reach */
  nearestMinutes: number | null;
}

export interface CapacityCenterResult {
  id: number;
  /** candidates whose nearest center with an open slot is this one - the utilization numerator */
  demand: number;
  assigned: number;
  slots: number;
}

export interface CapacityResult {
  groups: Map<string, CapacityGroupResult>;
  centers: Map<number, CapacityCenterResult>;
  totals: { candidates: number; assigned: number; flagged: number };
}

export class CapacityEngine {
  private readonly reach: UtilizationEngine;
  private readonly centers: CapacityCenter[];

  constructor(centers: CapacityCenter[], opts: EngineOptions) {
    this.centers = centers;
    this.reach = new UtilizationEngine(centers, opts);
  }

  run(groups: SimGroup[]): CapacityResult {
    const open = new Map<number, number>(this.centers.map((c) => [c.id, Math.max(0, c.slots)]));
    const demand = new Map<number, number>(this.centers.map((c) => [c.id, 0]));
    const assigned = new Map<number, number>(this.centers.map((c) => [c.id, 0]));
    const results = new Map<string, CapacityGroupResult>();
    let candidates = 0;
    let assignedTotal = 0;
    let flagged = 0;

    // City key order makes the allocation repeatable regardless of database order.
    for (const g of [...groups].sort((a, b) => a.key.localeCompare(b.key))) {
      const hits = this.reach.reachable({ key: g.key, lat: g.lat, lon: g.lon, islandId: g.islandId });
      const firstOpen = hits.find((h) => (open.get(h.center.id) ?? 0) > 0);
      if (firstOpen) demand.set(firstOpen.center.id, (demand.get(firstOpen.center.id) ?? 0) + g.count);

      let left = g.count;
      for (const hit of hits) {
        if (left <= 0) break;
        const available = open.get(hit.center.id) ?? 0;
        if (available <= 0) continue;
        const take = Math.min(available, left);
        open.set(hit.center.id, available - take);
        assigned.set(hit.center.id, (assigned.get(hit.center.id) ?? 0) + take);
        left -= take;
      }

      const placed = g.count - left;
      results.set(g.key, {
        key: g.key,
        count: g.count,
        assigned: placed,
        flagged: left,
        nearestMinutes: hits[0]?.minutes ?? null,
      });
      candidates += g.count;
      assignedTotal += placed;
      flagged += left;
    }

    return {
      groups: results,
      centers: new Map(
        this.centers.map((c) => [
          c.id,
          {
            id: c.id,
            demand: demand.get(c.id) ?? 0,
            assigned: assigned.get(c.id) ?? 0,
            slots: Math.max(0, c.slots),
          },
        ]),
      ),
      totals: { candidates, assigned: assignedTotal, flagged },
    };
  }
}
