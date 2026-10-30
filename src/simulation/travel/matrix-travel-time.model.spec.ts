import { MatrixTravelTimeModel, pairKey } from './matrix-travel-time.model';
import { EstimatedTravelTimeModel } from './travel-time.model';

const estimate = new EstimatedTravelTimeModel(1.35, 35, 90);
const city = (key: string | null, islandId: number | null = 1) => ({ key, lat: 10, lon: 123, islandId });
const center = (id: number, islandId: number | null = 1) => ({ id, lat: 10.1, lon: 123.1, islandId });

describe('EstimatedTravelTimeModel', () => {
  it('is km x detour / speed on the same island', () => {
    expect(estimate.minutes(city('a'), center(1), 35)).toBeCloseTo(81, 5); // 35 km x 1.35 / 35 km/h = 1.35 h
  });

  it('adds the ferry allowance across islands, and when an island is unknown', () => {
    expect(estimate.minutes(city('a', 1), center(1, 2), 10)).toBeCloseTo(23.14 + 90, 1);
    expect(estimate.minutes(city('a', null), center(1, null), 10)).toBeCloseTo(23.14 + 90, 1);
  });
});

describe('MatrixTravelTimeModel', () => {
  it('behaves exactly like the fallback while the matrix is empty', () => {
    const m = new MatrixTravelTimeModel(estimate);
    expect(m.name).toBe(estimate.name);
    expect(m.minutes(city('a'), center(1), 20)).toBe(estimate.minutes(city('a'), center(1), 20));
  });

  it('uses the routed minutes for a known (city, center) pair and the fallback for the rest', () => {
    const m = new MatrixTravelTimeModel(estimate);
    m.setMatrix(new Map([[pairKey('a', 1), 12.5]]), new Date('2026-10-21T00:00:00Z'));
    expect(m.minutes(city('a'), center(1), 20)).toBe(12.5);
    expect(m.minutes(city('a'), center(2), 20)).toBe(estimate.minutes(city('a'), center(2), 20)); // pair not routed
    expect(m.minutes(city('b'), center(1), 20)).toBe(estimate.minutes(city('b'), center(1), 20)); // other city
    expect(m.minutes(city(null), center(1), 20)).toBe(estimate.minutes(city(null), center(1), 20)); // a raw point has no key
    expect(m.name).toContain('osrm');
    expect(m.name).toContain('1 pairs');
    expect(m.name).toContain('2026-10-21');
  });

  it('overlays extra pairs (a live-routed pin) without changing the base model', () => {
    const m = new MatrixTravelTimeModel(estimate);
    m.setMatrix(new Map([[pairKey('a', 1), 12.5]]));
    const o = m.withOverlay(new Map([[pairKey('a', -1), 7]]));
    expect(o.minutes(city('a'), center(-1), 20)).toBe(7);
    expect(o.minutes(city('a'), center(1), 20)).toBe(12.5); // falls through to the base matrix
    expect(m.minutes(city('a'), center(-1), 20)).toBe(estimate.minutes(city('a'), center(-1), 20));
  });
});
