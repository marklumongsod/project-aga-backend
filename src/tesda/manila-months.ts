/** Asia/Manila calendar months (UTC+8, no daylight saving), as epoch seconds of the month's first midnight. */
const MANILA_OFFSET_MS = 8 * 3600 * 1000;

export interface ManilaMonth {
  /** "2026-11-01", the form the TESDA API takes */
  label: string;
  /** epoch seconds of 00:00 Asia/Manila on the 1st */
  epoch: number;
}

const month = (year: number, month0: number): ManilaMonth => {
  const d = new Date(Date.UTC(year, month0, 1));
  return {
    label: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`,
    epoch: (d.getTime() - MANILA_OFFSET_MS) / 1000,
  };
};

const manilaYearMonth = (epochSec: number) => {
  const d = new Date(epochSec * 1000 + MANILA_OFFSET_MS);
  return { year: d.getUTCFullYear(), month0: d.getUTCMonth() };
};

/** This month and the `count - 1` after it. */
export function upcomingMonths(nowEpochSec: number, count: number): ManilaMonth[] {
  const { year, month0 } = manilaYearMonth(nowEpochSec);
  return Array.from({ length: count }, (_, i) => month(year, month0 + i));
}

/** The three months of the next calendar quarter (Oct-Dec now -> Jan-Mar). */
export function nextQuarterMonths(nowEpochSec: number): ManilaMonth[] {
  const { year, month0 } = manilaYearMonth(nowEpochSec);
  const start = Math.floor(month0 / 3) * 3 + 3;
  return [0, 1, 2].map((i) => month(year, start + i));
}
