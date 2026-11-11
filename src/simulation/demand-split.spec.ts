import { EVEN_SHARE, splitByGraduates, apportion, graduateDemand } from './demand-split';

describe('splitByGraduates (province-only graduates over the province towns)', () => {
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

describe('graduateDemand (candidates per town from upcoming TESDA graduates)', () => {
  const towns = new Map([
    ['P1', ['city', 'town', 'island']],
    ['P2', ['far']],
  ]);

  it('uses the graduates placed in a town as they are, with nothing estimated', () => {
    const out = graduateDemand(towns, new Map([['city', 90], ['town', 10]]), new Map());
    expect(out.get('city')).toEqual({ count: 90, estimated: 0 });
    expect(out.get('town')).toEqual({ count: 10, estimated: 0 });
    expect(out.has('island')).toBe(false); // no graduates and nothing to split: no candidates
  });

  it('splits province-only graduates over the province towns and marks that part as estimated', () => {
    const out = graduateDemand(towns, new Map([['city', 90], ['town', 10]]), new Map([['P1', 300]]));
    const sum = [...out.values()].reduce((a, t) => a + t.count, 0);
    expect(sum).toBe(400); // every graduate is counted once
    // 20% of 300 evenly (20 each), 80% by graduates (216 / 24 / 0)
    expect(out.get('city')).toEqual({ count: 90 + 236, estimated: 236 });
    expect(out.get('town')).toEqual({ count: 10 + 44, estimated: 44 });
    expect(out.get('island')).toEqual({ count: 20, estimated: 20 }); // the even floor reaches a town with no school
  });

  it('keeps other provinces separate', () => {
    const out = graduateDemand(towns, new Map([['city', 5]]), new Map([['P2', 7]]));
    expect(out.get('far')).toEqual({ count: 7, estimated: 7 });
    expect(out.get('city')).toEqual({ count: 5, estimated: 0 });
  });

  it('drops province-only graduates of a province with no towns', () => {
    expect(graduateDemand(towns, new Map(), new Map([['P9', 50]])).size).toBe(0);
  });
});
