/**
 * Density (team doc): how many enrollee-candidates live in a municipality/city (or province), whether or not an
 * assessment center is available there. A hotspot is the densest fifth of the areas being compared.
 * Classes come from the data (quintiles), so the map reads well at every level: provinces of the country, cities of
 * a province.
 */
export interface DensityClass {
  band: number;
  label: string;
  color: string;
}

/** light -> dark blue */
const PALETTE = ['#dbe9f6', '#a9cbe8', '#6aa3d4', '#2f77b8', '#0b3d7a'];
export const NO_CANDIDATES = -1;
const GREY = '#e6e9f0';

const fmt = (n: number) => n.toLocaleString('en-PH');

/** Upper bounds of the first classes (ascending, distinct); everything above the last bound is the hotspot class. */
export function densityBreaks(candidates: number[]): number[] {
  const v = candidates.filter((c) => c > 0).sort((a, b) => a - b);
  if (v.length < 2) return [];
  const at = (p: number) => v[Math.min(v.length - 1, Math.ceil(v.length * p) - 1)]!;
  const max = v[v.length - 1]!;
  const out: number[] = [];
  for (const p of [0.2, 0.4, 0.6, 0.8]) {
    const b = at(p);
    if (b < max && (out.length === 0 || b > out[out.length - 1]!)) out.push(b);
  }
  return out;
}

/** -1 = no candidates; otherwise 0..breaks.length (the last is the hotspot class). */
export function densityBand(candidates: number, breaks: number[]): number {
  if (!(candidates > 0)) return NO_CANDIDATES;
  const i = breaks.findIndex((b) => candidates <= b);
  return i === -1 ? breaks.length : i;
}

export function densityLegend(breaks: number[], max: number): DensityClass[] {
  const n = breaks.length + 1;
  // spread the palette over however many classes there are
  const color = (i: number) => PALETTE[n === 1 ? 2 : Math.round((i * (PALETTE.length - 1)) / (n - 1))]!;
  const out: DensityClass[] = [];
  for (let i = 0; i < n; i++) {
    const lo = i === 0 ? 1 : breaks[i - 1]! + 1;
    const hi = i < breaks.length ? breaks[i]! : max;
    const hot = i === n - 1 && n > 1;
    out.push({
      band: i,
      label: hot ? `${fmt(lo)}+ candidates (hotspot)` : lo >= hi ? `${fmt(lo)} candidates` : `${fmt(lo)}-${fmt(hi)} candidates`,
      color: color(i),
    });
  }
  out.push({ band: NO_CANDIDATES, label: 'No candidates', color: GREY });
  return out;
}
