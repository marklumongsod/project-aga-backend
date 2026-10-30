import { iqrFences, mad, median, quantile, robustLimit } from './robust-stats';

describe('robust statistics', () => {
  it('median and quantiles', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(median([])).toBeNaN();
  });

  it('MAD ignores an outlier that wrecks the standard deviation', () => {
    const clean = [10, 11, 9, 10, 12, 10, 11];
    const dirty = [...clean, 500];
    expect(mad(dirty)).toBeLessThan(2);
    expect(median(dirty)).toBeLessThan(11);
  });

  it('robustLimit accepts normal spread, rejects a far point, and respects the floor', () => {
    const km = [0.5, 0.8, 1.1, 0.9, 1.4, 0.7, 1.0, 1.2]; // other centers' distances to their city centre
    const limit = robustLimit(km, 3, 1);
    expect(limit).toBeGreaterThan(1.4); // everything in the sample is inside
    expect(limit).toBeLessThan(4);
    expect(26).toBeGreaterThan(limit); // a center 26 km away is an outlier
    expect(robustLimit([0.1, 0.1, 0.1], 3, 2)).toBe(2); // floor
    expect(robustLimit([], 3, 5)).toBe(5);
  });

  it('IQR fences', () => {
    const f = iqrFences([10, 12, 11, 13, 12, 11, 90]);
    expect(f.high).toBeLessThan(90);
    expect(f.low).toBeGreaterThan(0);
  });
});
