/**
 * Month-by-month figures for a proposal report (pure, no Nest or DB imports).
 *
 * The reach check is per city and doesn't depend on how many candidates there are, so one before/after run decides
 * which cities have no center in reach; each month's candidates (graduates finishing that month) are then counted
 * against it. Utilization is the team definition: candidates ÷ the slots of the area's centers for that month; the
 * proposed center adds `pinSlots` (a typical center's slots, since a pin has no slots of its own).
 */

export type ReportLevel = 'NATIONAL' | 'REGION' | 'PROVINCE';

export interface ReportAreaRef {
  level: ReportLevel;
  code: string;
  name: string;
}

export interface ReportCity {
  key: string;
  provincePsgc: string;
  regionPsgc: string;
}

export interface PeriodFigures {
  candidates: number;
  flaggedBefore: number;
  flaggedAfter: number;
  desertsBefore: number;
  desertsAfter: number;
  /** slots of the area's centers in the period; null = no slot data */
  slots: number | null;
  /** the slots the proposed center is assumed to add; null = no slot data */
  pinSlots: number | null;
  utilizationBefore: number | null;
  utilizationAfter: number | null;
}

export interface ReportAreaFigures extends ReportAreaRef {
  /** one per month in `months` (index 0 = the current month) */
  months: PeriodFigures[];
  /** months 1-3 together (the months after the current one) */
  next3: PeriodFigures;
}

/** Asia/Manila month starts (epoch seconds): the month of `now` and the `count - 1` after it. */
export function reportMonths(nowSeconds: number, count = 4): number[] {
  const manila = new Date((nowSeconds + 8 * 3600) * 1000);
  const y = manila.getUTCFullYear();
  const m = manila.getUTCMonth();
  return Array.from({ length: count }, (_, i) => Date.UTC(y, m + i, 1) / 1000 - 8 * 3600);
}

/** `REGION:0600000000`, `PROVINCE:...`, `NATIONAL:PH`: the key slot totals are given under. */
export const areaKey = (a: { level: ReportLevel; code: string }) => `${a.level}:${a.code}`;

const inArea = (a: ReportAreaRef, c: ReportCity) =>
  a.level === 'NATIONAL' || (a.level === 'REGION' ? c.regionPsgc === a.code : c.provincePsgc === a.code);

const rate = (candidates: number, slots: number | null) => (slots && slots > 0 ? candidates / slots : null);

function period(
  area: ReportAreaRef,
  cities: ReportCity[],
  counts: Array<ReadonlyMap<string, number> | undefined>,
  unreachedBefore: ReadonlySet<string>,
  unreachedAfter: ReadonlySet<string>,
  slots: Array<number | null>,
  pinSlots: Array<number | null>,
): PeriodFigures {
  let candidates = 0;
  let flaggedBefore = 0;
  let flaggedAfter = 0;
  let desertsBefore = 0;
  let desertsAfter = 0;
  for (const c of cities) {
    if (!inArea(area, c)) continue;
    const n = counts.reduce((s, m) => s + (m?.get(c.key) ?? 0), 0);
    if (n <= 0) continue;
    candidates += n;
    if (unreachedBefore.has(c.key)) {
      flaggedBefore += n;
      desertsBefore += 1;
    }
    if (unreachedAfter.has(c.key)) {
      flaggedAfter += n;
      desertsAfter += 1;
    }
  }
  const sum = (xs: Array<number | null>) => (xs.some((x) => x !== null) ? xs.reduce<number>((s, x) => s + (x ?? 0), 0) : null);
  const s = sum(slots);
  const p = sum(pinSlots);
  return {
    candidates,
    flaggedBefore,
    flaggedAfter,
    desertsBefore,
    desertsAfter,
    slots: s,
    pinSlots: p,
    utilizationBefore: rate(candidates, s),
    utilizationAfter: p === null ? null : rate(candidates, (s ?? 0) + p),
  };
}

export function reportFigures(input: {
  areas: ReportAreaRef[];
  cities: ReportCity[];
  /** month starts; index 0 is the current month */
  months: number[];
  /** candidates per city, per month start */
  candidates: ReadonlyMap<number, ReadonlyMap<string, number>>;
  /** cities with no center in reach without / with the proposed center */
  unreachedBefore: ReadonlySet<string>;
  unreachedAfter: ReadonlySet<string>;
  /** slots per month start, per `areaKey` (missing = no slot data) */
  slots: ReadonlyMap<number, ReadonlyMap<string, number>>;
  /** slots the proposed center adds, per month start (missing = no slot data) */
  pinSlots: ReadonlyMap<number, number>;
}): ReportAreaFigures[] {
  const { cities, months, candidates, unreachedBefore, unreachedAfter } = input;
  const slotsOf = (a: ReportAreaRef, m: number) => input.slots.get(m)?.get(areaKey(a)) ?? null;
  const pinOf = (m: number) => input.pinSlots.get(m) ?? null;
  return input.areas.map((a) => {
    const one = (ms: number[]) =>
      period(
        a,
        cities,
        ms.map((m) => candidates.get(m)),
        unreachedBefore,
        unreachedAfter,
        ms.map((m) => slotsOf(a, m)),
        ms.map(pinOf),
      );
    return { ...a, months: months.map((m) => one([m])), next3: one(months.slice(1, 4)) };
  });
}
