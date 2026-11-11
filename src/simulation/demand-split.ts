/** Share of a split that is spread evenly over the towns; the rest follows their TESDA graduates. */
export const EVEN_SHARE = 0.2;

/**
 * Split a total (graduates the TESDA API places only in a province) over that province's towns: EVEN_SHARE of it
 * evenly, the rest in proportion to each town's own graduates (the schools in it). Towns with no graduates still get
 * the even part, so rural demand is not erased. With no graduates in any of the towns it is an even split. Pure; the
 * result sums to `total`.
 */
export function splitByGraduates(total: number, keys: string[], graduates: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  if (!keys.length) return out;
  const g = keys.map((k) => Math.max(graduates.get(k) ?? 0, 0));
  const sum = g.reduce((a, b) => a + b, 0);
  keys.forEach((k, i) => {
    const share = sum > 0 ? EVEN_SHARE / keys.length + ((1 - EVEN_SHARE) * g[i]!) / sum : 1 / keys.length;
    out.set(k, total * share);
  });
  return out;
}

/** Whole shares that add up to the (rounded) total: floors, then the leftovers go to the largest fractions. Pure. */
export function apportion(shares: ReadonlyMap<string, number>): Map<string, number> {
  const rows = [...shares].map(([key, v]) => ({ key, whole: Math.floor(v), rest: v - Math.floor(v) }));
  const total = Math.round([...shares.values()].reduce((a, b) => a + b, 0));
  let left = total - rows.reduce((a, r) => a + r.whole, 0);
  for (const r of [...rows].sort((a, b) => b.rest - a.rest || a.key.localeCompare(b.key))) {
    if (left <= 0) break;
    r.whole += 1;
    left -= 1;
  }
  return new Map(rows.map((r) => [r.key, r.whole]));
}

export interface TownDemand {
  /** candidates in the town */
  count: number;
  /** the part of `count` that is a share of province-only graduates (an estimate), not graduates placed in the town */
  estimated: number;
}

/**
 * Candidates per town from upcoming TESDA graduates: the graduates the API places in the town, plus the town's share
 * of the graduates it places only in the province (`splitByGraduates` over the province's towns). Whole numbers that
 * add up to the graduates (`apportion`); towns with none are left out. Pure.
 */
export function graduateDemand(
  townsByProvince: ReadonlyMap<string, readonly string[]>,
  towns: ReadonlyMap<string, number>,
  provinces: ReadonlyMap<string, number>,
): Map<string, TownDemand> {
  const shares = new Map<string, number>(towns);
  const split = new Map<string, number>();
  for (const [province, total] of provinces) {
    for (const [k, v] of splitByGraduates(total, [...(townsByProvince.get(province) ?? [])], towns)) {
      shares.set(k, (shares.get(k) ?? 0) + v);
      split.set(k, (split.get(k) ?? 0) + v);
    }
  }
  const out = new Map<string, TownDemand>();
  for (const [k, count] of apportion(shares)) {
    if (count > 0) out.set(k, { count, estimated: Math.min(count, Math.round(split.get(k) ?? 0)) });
  }
  return out;
}
