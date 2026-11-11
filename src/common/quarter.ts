/** Asia/Manila calendar quarters, as epoch seconds (the project stores every date as epoch seconds). */
const MANILA_OFFSET_MS = 8 * 3600 * 1000;

export interface Quarter {
  /** "2026-Q4" */
  label: string;
  year: number;
  /** 1-4 */
  quarter: number;
  /** epoch seconds, 00:00 Asia/Manila on the first day of the quarter */
  start: number;
  /** epoch seconds, 00:00 Asia/Manila on the first day after the quarter */
  end: number;
}

const QUARTER = /^(\d{4})-Q([1-4])$/;

/** Epoch seconds of 00:00 Asia/Manila on the first day of a month. `month` is 1-12. */
export function manilaMonthStart(year: number, month: number): number {
  return (Date.UTC(year, month - 1, 1) - MANILA_OFFSET_MS) / 1000;
}

/** "2026-Q4" -> quarter boundaries; null when the label is not a calendar quarter. */
export function parseQuarter(label: string): Quarter | null {
  const m = QUARTER.exec(label.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const quarter = Number(m[2]);
  return {
    label: `${year}-Q${quarter}`,
    year,
    quarter,
    start: manilaMonthStart(year, (quarter - 1) * 3 + 1),
    end: quarter === 4 ? manilaMonthStart(year + 1, 1) : manilaMonthStart(year, quarter * 3 + 1),
  };
}

/** The quarter an epoch-second date falls in, in Asia/Manila. */
export function quarterOf(epochSeconds: number): Quarter {
  const d = new Date(epochSeconds * 1000 + MANILA_OFFSET_MS);
  const year = d.getUTCFullYear();
  const quarter = Math.floor(d.getUTCMonth() / 3) + 1;
  return parseQuarter(`${year}-Q${quarter}`)!;
}

/** The current quarter in Asia/Manila. */
export function currentQuarter(now: number = Date.now()): Quarter {
  return quarterOf(Math.floor(now / 1000));
}

/** The three month-start epochs of a quarter, in order. */
export function quarterMonths(q: Quarter): number[] {
  return [
    manilaMonthStart(q.year, (q.quarter - 1) * 3 + 1),
    manilaMonthStart(q.year, (q.quarter - 1) * 3 + 2),
    manilaMonthStart(q.year, (q.quarter - 1) * 3 + 3),
  ];
}
