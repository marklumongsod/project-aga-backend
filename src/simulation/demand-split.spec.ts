import { EVEN_SHARE, splitByGraduates, apportion } from './demand-split';

describe('splitByGraduates (a province total over towns without BSRS figures)', () => {
  const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

  it('is an even split when no town has graduates', () => {
    const m = splitByGraduates(900, ['a', 'b', 'c'], new Map());
    expect([...m.values()]).toEqual([300, 300, 300]);
  });

  it('puts most of the total where the graduates are, and keeps an even floor everywhere', () => {
    // Palawan-like: one city with most graduates, one town with a few, the rest with none
    const keys = ['city', 'town', 'x', 'y'];
    const m = splitByGraduates(1000, keys, new Map([['city', 90], ['town', 10]]));
    expect(total(m)).toBeCloseTo(1000, 6);
    const floor = (1000 * EVEN_SHARE) / keys.length; // 50
    expect(m.get('x')).toBeCloseTo(floor, 6);
    expect(m.get('y')).toBeCloseTo(floor, 6);
    expect(m.get('city')).toBeCloseTo(floor + 1000 * (1 - EVEN_SHARE) * 0.9, 6); // 50 + 720
    expect(m.get('town')).toBeCloseTo(floor + 1000 * (1 - EVEN_SHARE) * 0.1, 6); // 50 + 80
  });

  it('ignores graduates of towns outside the split and negative counts', () => {
    const m = splitByGraduates(100, ['a', 'b'], new Map([['a', 1], ['elsewhere', 999], ['b', -5]]));
    expect(total(m)).toBeCloseTo(100, 6);
    expect(m.get('a')!).toBeGreaterThan(m.get('b')!);
  });

  it('returns nothing for no towns', () => {
    expect(splitByGraduates(100, [], new Map()).size).toBe(0);
  });
});

describe('apportion', () => {
  it('gives whole numbers that add up to the total, leftovers to the largest fractions', () => {
    const out = apportion(new Map([['a', 1.6], ['b', 1.3], ['c', 2.1]]));
    expect([...out.values()].reduce((x, y) => x + y, 0)).toBe(5);
    expect(out.get('a')).toBe(2);
    expect(out.get('b')).toBe(1);
    expect(out.get('c')).toBe(2);
  });
});
