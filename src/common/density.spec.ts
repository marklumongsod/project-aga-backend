import { densityBand, densityBreaks, densityLegend } from './density';

describe('density classes (quintiles of the candidates being compared)', () => {
  const cities = [5, 10, 20, 30, 50, 80, 120, 300, 700, 2000]; // 10 areas

  it('splits into five classes with the densest fifth as the hotspot', () => {
    const breaks = densityBreaks(cities);
    expect(breaks).toEqual([10, 30, 80, 300]);
    expect(cities.map((c) => densityBand(c, breaks))).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it('puts areas without candidates in their own "no candidates" class', () => {
    const breaks = densityBreaks([0, 0, 5, 10, 20, 30, 50]);
    expect(densityBand(0, breaks)).toBe(-1);
    expect(densityBand(5, breaks)).toBe(0);
  });

  it('copes with ties and tiny samples (fewer classes, never an empty hotspot)', () => {
    expect(densityBreaks([])).toEqual([]);
    expect(densityBreaks([7])).toEqual([]);
    const same = densityBreaks([10, 10, 10, 10, 10]);
    expect(same).toEqual([]); // everything is the same: one class
    expect(densityBand(10, same)).toBe(0);
    const some = densityBreaks([1, 1, 1, 1, 100]);
    expect(densityBand(100, some)).toBe(some.length); // the one big area is the hotspot
  });

  it('labels the classes with their candidate ranges and marks the hotspot', () => {
    const breaks = densityBreaks(cities);
    const legend = densityLegend(breaks, 2000);
    expect(legend.map((l) => l.label)).toEqual([
      '1-10 candidates',
      '11-30 candidates',
      '31-80 candidates',
      '81-300 candidates',
      '301+ candidates (hotspot)',
      'No candidates',
    ]);
    expect(legend.map((l) => l.band)).toEqual([0, 1, 2, 3, 4, -1]);
    expect(new Set(legend.map((l) => l.color)).size).toBe(6); // distinct colours
  });
});
