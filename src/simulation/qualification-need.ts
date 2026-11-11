/**
 * Which qualifications a new center should offer, from what the graduates of the provinces it would serve have.
 * Pure functions: the service reads the data and passes it in.
 */
export interface DemandRow {
  provincePsgc: string;
  /** as the TESDA API names it ("Cookery II") */
  qualification: string;
  graduates: number;
}

export interface QualificationNeed {
  qualification: string;
  /** candidates among those the site would serve who are likely to want it (an estimate) */
  estimatedCandidates: number;
  /** estimatedCandidates / the candidates served in provinces that have graduate data, 0 to 1 */
  share: number;
  /** existing centers in those provinces that offer it */
  centersOffering: number;
}

/** "Driving NC II" and "Driving II" are the same qualification. */
export const qualificationKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/\bnc\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * For each province the site would serve, the candidates it serves there are split over that province's qualifications
 * by the share of its graduates in each. Summed over provinces and ranked, the top ones are the qualifications the site
 * should offer first. A province with no graduate data adds nothing (and is left out of the shares). Rows are matched
 * by name (`qualificationKey`).
 *
 * `supply(provinces, qualification)` says how many existing centers in those provinces offer it.
 */
export function estimateQualificationNeed(
  served: Array<{ provincePsgc: string; count: number }>,
  demand: DemandRow[],
  supply: (provinces: Set<string>, qualification: string) => number,
  top = 3,
): QualificationNeed[] {
  const servedBy = new Map<string, number>();
  for (const s of served) servedBy.set(s.provincePsgc, (servedBy.get(s.provincePsgc) ?? 0) + s.count);

  const totalOf = new Map<string, number>();
  for (const d of demand) totalOf.set(d.provincePsgc, (totalOf.get(d.provincePsgc) ?? 0) + d.graduates);

  const est = new Map<string, { qualification: string; est: number }>();
  let withData = 0;
  for (const [prov, count] of servedBy) {
    const total = totalOf.get(prov);
    if (!total) continue;
    withData += count;
    for (const d of demand) {
      if (d.provincePsgc !== prov || d.graduates <= 0) continue;
      const key = qualificationKey(d.qualification);
      const cur = est.get(key) ?? { qualification: d.qualification, est: 0 };
      cur.est += (count * d.graduates) / total;
      est.set(key, cur);
    }
  }
  if (!withData) return [];

  const provinces = new Set(servedBy.keys());
  return [...est.values()]
    .map((v) => ({
      qualification: v.qualification,
      estimatedCandidates: Math.round(v.est),
      share: v.est / withData,
      centersOffering: supply(provinces, v.qualification),
    }))
    .sort((a, b) => b.estimatedCandidates - a.estimatedCandidates || a.centersOffering - b.centersOffering || a.qualification.localeCompare(b.qualification))
    .slice(0, top);
}
