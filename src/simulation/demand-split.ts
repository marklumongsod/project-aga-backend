/** Share of a split that is spread evenly over the towns; the rest follows their TESDA graduates. */
export const EVEN_SHARE = 0.2;

/**
 * Split a total (a province's BSRS completers minus its measured cities) over towns that have no figure of their own:
 * EVEN_SHARE of it evenly, the rest in proportion to each town's TESDA graduates (the schools in it, from the TESDA
 * API). Towns with no graduates still get the even part, so rural demand is not erased. With no graduates in any of
 * the towns it is an even split. Pure; the result sums to `total`.
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
