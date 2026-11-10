import { desertLevel, DESERT_LEVELS, isoBand, toEpoch } from './rate-band';

describe('isoBand', () => {
  it('splits by thirds of the limit, then 1.5x', () => {
    expect([10, 45, 80, 120, 200].map((m) => isoBand(m, 90))).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('desertLevel (team doc: assessment desert levels by enrollee-candidates)', () => {
  it.each([
    [0, 0],
    [-3, 0],
    [1, 1],
    [200, 1],
    [201, 2],
    [400, 2],
    [401, 3],
    [600, 3],
    [601, 4],
    [4525, 4],
  ])('%i candidates -> level %i', (candidates, level) => {
    expect(desertLevel(candidates)).toBe(level);
  });

  it('has a legend entry for every level, from "not a desert" to level 4', () => {
    expect(DESERT_LEVELS.map((l) => l.band)).toEqual([0, 1, 2, 3, 4]);
    expect(DESERT_LEVELS[4]!.label).toContain('601 candidates and up');
  });
});

describe('toEpoch (team convention: epoch time in all date columns)', () => {
  it('passes epoch seconds through, including the string form PostgreSQL gives for bigint', () => {
    expect(toEpoch(1792570075)).toBe(1792570075);
    expect(toEpoch('1792570075')).toBe(1792570075);
    expect(toEpoch(1792570075.9)).toBe(1792570075);
  });
  it('converts a Date or ISO string, and keeps null as null', () => {
    expect(toEpoch(new Date('2026-10-21T08:07:55Z'))).toBe(1792570075);
    expect(toEpoch('2026-10-21T08:07:55Z')).toBe(1792570075);
    expect(toEpoch(null)).toBeNull();
    expect(toEpoch(undefined)).toBeNull();
  });
});
