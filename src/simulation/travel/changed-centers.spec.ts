import { centersToReroute } from './changed-centers';

describe('centersToReroute', () => {
  const a = { id: 1, lat: 10, lon: 122 };
  const b = { id: 2, lat: 11, lon: 123 };

  it('returns nothing when no center changed and all are routed', () => {
    expect(centersToReroute([a, b], [a, b], new Set([1, 2]))).toEqual([]);
  });

  it('returns a center new to the analysis (added by TESDA or recovered)', () => {
    const c = { id: 3, lat: 12, lon: 124 };
    expect(centersToReroute([a, b], [a, b, c], new Set([1, 2]))).toEqual([3]);
  });

  it('returns a center whose point moved, but not a float round-trip', () => {
    expect(centersToReroute([a, b], [{ ...a, lat: 10.01 }, { ...b, lon: 123.000001 }], new Set([1, 2]))).toEqual([1]);
  });

  it('returns a center that has no travel times yet, so an OSRM outage heals next time', () => {
    expect(centersToReroute([a, b], [a, b], new Set([1]))).toEqual([2]);
  });

  it('ignores centers that left the analysis', () => {
    expect(centersToReroute([a, b], [a], new Set([1, 2]))).toEqual([]);
  });
});
