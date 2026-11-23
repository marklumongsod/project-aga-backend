/**
 * Utilization bands for the capacity view. Utilization is candidates wanting a center / its slots:
 *   <=100%: green to yellow (capacity available or exactly full)
 *   >100%:  red (more candidates than slots)
 */
export interface UtilizationClass {
  band: number;
  label: string;
  color: string;
}

export const NO_UTILIZATION = -1;

export const UTILIZATION_LEVELS: ReadonlyArray<UtilizationClass> = [
  { band: NO_UTILIZATION, label: 'No slots', color: '#e6e9f0' },
  { band: 0, label: '0-25% (low)', color: '#4caf6e' },
  { band: 1, label: '25-50% (moderate)', color: '#a3c94a' },
  { band: 2, label: '50-75% (high)', color: '#f4d03f' },
  { band: 3, label: '75-100% (near full)', color: '#f39c12' },
  { band: 4, label: 'Above 100% (over capacity)', color: '#c40000' },
];

/** -1 = no slots/unknown; 0..4 otherwise. `rate` is a fraction (1.5 = 150%). */
export function utilizationBand(rate: number | null | undefined): number {
  if (rate == null || !Number.isFinite(rate)) return NO_UTILIZATION;
  if (rate <= 0.25) return 0;
  if (rate <= 0.5) return 1;
  if (rate <= 0.75) return 2;
  if (rate <= 1) return 3;
  return 4;
}
