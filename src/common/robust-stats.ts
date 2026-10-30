/**
 * Robust statistics for judging whether a value belongs with its peers. The median and the median absolute deviation
 * (MAD) are not dragged around by the odd bad value the way the mean and standard deviation are.
 */
export function quantile(values: number[], q: number): number {
  if (!values.length) return NaN;
  const v = [...values].sort((a, b) => a - b);
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo]! + (v[hi]! - v[lo]!) * (pos - lo);
}

export const median = (values: number[]) => quantile(values, 0.5);

/** Median absolute deviation, scaled by 1.4826 so it is comparable to a standard deviation for normal data. */
export function mad(values: number[]): number {
  if (!values.length) return NaN;
  const m = median(values);
  return 1.4826 * median(values.map((x) => Math.abs(x - m)));
}

/**
 * The largest value still considered normal for this group: median + k x MAD (a robust z-score of k, default 3),
 * and never below `floor` so a very tight group doesn't reject everything slightly different.
 */
export function robustLimit(values: number[], k = 3, floor = 0): number {
  if (!values.length) return floor;
  return Math.max(floor, median(values) + k * mad(values));
}

/** Tukey fences: values outside [low, high] are outliers (1.5 x IQR from the quartiles). */
export function iqrFences(values: number[]): { q1: number; q3: number; low: number; high: number } {
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  const iqr = q3 - q1;
  return { q1, q3, low: q1 - 1.5 * iqr, high: q3 + 1.5 * iqr };
}
