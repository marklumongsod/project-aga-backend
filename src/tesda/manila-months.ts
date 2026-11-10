/** Asia/Manila calendar months (UTC+8, no daylight saving), as epoch seconds of the month's first midnight. */
const MANILA_OFFSET_MS = 8 * 3600 * 1000;

/** "2026-12" (the TESDA API's finish month) -> epoch seconds of 00:00 Asia/Manila on 1 December 2026; null if not a month. */
export function manilaMonthStart(label: string): number | null {
  const m = /^(\d{4})-(\d{2})$/.exec(label.trim());
  if (!m) return null;
  const month0 = Number(m[2]) - 1;
  if (month0 < 0 || month0 > 11) return null;
  return (Date.UTC(Number(m[1]), month0, 1) - MANILA_OFFSET_MS) / 1000;
}
