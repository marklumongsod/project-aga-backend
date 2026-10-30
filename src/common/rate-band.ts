/** Isochrone bands for a center's reach: <=1/3, <=2/3, <=1x, <=1.5x the travel limit, beyond. */
export function isoBand(minutes: number, limit: number): number {
  if (minutes <= limit / 3) return 0;
  if (minutes <= (2 * limit) / 3) return 1;
  if (minutes <= limit) return 2;
  if (minutes <= 1.5 * limit) return 3;
  return 4;
}

/** Dates leave the API as epoch seconds (team convention: epoch time in all date columns). */
export const toEpoch = (d: Date | string | number | null | undefined): number | null => {
  if (d == null) return null;
  if (typeof d === 'number') return Math.floor(d); // already epoch seconds (the date columns are bigint epoch)
  if (typeof d === 'string' && /^\d+$/.test(d)) return Number(d); // bigint straight from a raw SQL query
  return Math.floor(new Date(d).getTime() / 1000);
};

/**
 * Assessment desert levels (team doc): a city/municipality that has candidates but no assessment center within the
 * 90-minute travel range. The level is the number of enrollee-candidates there.
 *   Level 1: 1-20   Level 2: 21-40   Level 3: 41-60   Level 4: more than 60
 */
export const DESERT_LEVELS = [
  { band: 0, label: 'Not an assessment desert', color: '#e6e9f0' },
  { band: 1, label: 'Level 1: 1-20 candidates', color: '#ff9e91' },
  { band: 2, label: 'Level 2: 21-40 candidates', color: '#ff5a4a' },
  { band: 3, label: 'Level 3: 41-60 candidates', color: '#e8281e' },
  { band: 4, label: 'Level 4: more than 60 candidates', color: '#c40000' },
] as const;

/** 0 = not a desert (no candidates); otherwise 1-4. Only call it for a city that no center can reach. */
export function desertLevel(candidates: number): number {
  if (!(candidates > 0)) return 0;
  if (candidates <= 20) return 1;
  if (candidates <= 40) return 2;
  if (candidates <= 60) return 3;
  return 4;
}
