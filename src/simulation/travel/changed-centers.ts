/** A center as the travel matrix sees it: in the analysis, at this point. */
export interface CenterPoint {
  id: number;
  lat: number;
  lon: number;
}

/** About 1 m: closer than this is the same point (a float round-trip, not a move). */
const SAME_POINT_DEG = 0.00001;

/**
 * Which centers need routing again after a sync: those in the analysis now that are new to it (added by TESDA or
 * recovered by the data-quality check), those that moved, and those with no row in travel_times at all (e.g. OSRM
 * was down last time). Pure, so the monthly job can be tested without a database.
 *
 * @param before centers in the analysis before the sync
 * @param after  centers in the analysis after the sync and the data-quality check
 * @param routed ids that have at least one row in travel_times
 */
export function centersToReroute(before: CenterPoint[], after: CenterPoint[], routed: ReadonlySet<number>): number[] {
  const was = new Map(before.map((c) => [c.id, c]));
  const out: number[] = [];
  for (const c of after) {
    const b = was.get(c.id);
    const moved = !!b && (Math.abs(b.lat - c.lat) > SAME_POINT_DEG || Math.abs(b.lon - c.lon) > SAME_POINT_DEG);
    if (!b || moved || !routed.has(c.id)) out.push(c.id);
  }
  return out.sort((a, b) => a - b);
}
