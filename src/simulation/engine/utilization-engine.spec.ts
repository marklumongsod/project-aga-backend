import { EstimatedTravelTimeModel } from '../travel/travel-time.model';
import { SimCenter, SimGroup, UtilizationEngine } from './utilization-engine';

const travel = new EstimatedTravelTimeModel(1.35, 35, 90);
// searchKm is only how far to look (90 min at the fastest road pace); reach is decided by travel minutes alone
const opts = { limitMinutes: 90, searchKm: 113, travel };

// ~0.1 deg latitude = 11.1 km
const at = (lat: number, lon = 121): { lat: number; lon: number } => ({ lat, lon });
const center = (id: number, lat: number, islandId = 1): SimCenter => ({ id, ...at(lat), islandId });
const group = (key: string, lat: number, count: number, islandId = 1): SimGroup => ({ key, ...at(lat), islandId, count });

describe('UtilizationEngine (reach and deserts)', () => {
  it('serves candidates who have a center in reach: nobody is flagged, and capacity does not matter', () => {
    const e = new UtilizationEngine([center(1, 15.0)], opts);
    const r = e.run([group('a', 15.0, 5000)]); // far more candidates than any center could take
    expect(r.groups.get('a')!.flagged).toBe(0);
    expect(r.totals).toEqual({ candidates: 5000, flagged: 0 });
  });

  it('check 1: flags candidates who cannot reach any center within 90 minutes', () => {
    // 0.4 deg ~ 44.5 km straight line -> 103 min estimated road time (> 90)
    const e = new UtilizationEngine([center(1, 15.4)], opts);
    const r = e.run([group('a', 15.0, 4)]);
    expect(r.groups.get('a')!.flagged).toBe(4);
    expect(r.groups.get('a')!.nearestMinutes).toBeNull();
    expect(r.totals.flagged).toBe(4);
  });

  it('check 1: a sea crossing adds the ferry allowance', () => {
    const e = new UtilizationEngine([center(1, 15.05, 2)], opts); // 5.6 km away but on another island
    const r = e.run([group('a', 15.0, 4, 1)]);
    expect(r.groups.get('a')!.flagged).toBe(4);
  });

  it('reach is road travel time only: a center 67 km away is in reach when the road is fast enough', () => {
    const highway = { name: 'highway', minutes: () => 60 }; // 67 km straight line in 60 minutes by road
    const e = new UtilizationEngine([center(1, 15.6)], { ...opts, travel: highway });
    expect(e.run([group('a', 15.0, 2)]).groups.get('a')!.flagged).toBe(0);
  });

  it('...and out of reach when the road is slow, however close it is on the map', () => {
    const slow = { name: 'slow', minutes: () => 120 };
    const e = new UtilizationEngine([center(1, 15.05)], { ...opts, travel: slow }); // ~5.6 km straight line
    expect(e.run([group('a', 15.0, 2)]).groups.get('a')!.flagged).toBe(2);
  });

  it('the search bound never hides a reachable center: it only limits where to look', () => {
    const e = new UtilizationEngine([center(1, 16.5)], { ...opts, travel: { name: 'x', minutes: () => 30 } }); // ~167 km, beyond the bound
    expect(e.run([group('a', 15.0, 2)]).groups.get('a')!.flagged).toBe(2);
  });

  it('a larger travel limit brings more centers into reach', () => {
    const nearish = [center(1, 15.3)]; // ~33 km, ~60 min by the estimate
    const tight = new UtilizationEngine(nearish, { ...opts, limitMinutes: 30 }).run([group('a', 15.0, 4)]);
    const wide = new UtilizationEngine(nearish, { ...opts, limitMinutes: 90 }).run([group('a', 15.0, 4)]);
    expect(tight.groups.get('a')!.flagged).toBe(4);
    expect(wide.groups.get('a')!.flagged).toBe(0);
  });

  it('reports predicted demand on the nearest reachable center', () => {
    const e = new UtilizationEngine([center(1, 15.0), center(2, 15.1)], opts);
    const r = e.run([group('a', 15.0, 10), group('b', 15.02, 6)]);
    expect(r.centers.get(1)!.demand).toBe(16);
    expect(r.centers.get(2)!.demand).toBe(0);
    expect(r.totals.candidates).toBe(16);
  });

  it('lists the reachable centers nearest first, and is repeatable', () => {
    const e = new UtilizationEngine([center(2, 15.2), center(1, 15.1)], opts);
    const from = { key: 'a', ...at(15.0), islandId: 1 };
    expect(e.reachable(from).map((x) => x.center.id)).toEqual([1, 2]);
    const gs = [group('a', 15.0, 9), group('b', 15.04, 9)];
    expect([...e.run(gs).groups.values()]).toEqual([...e.run(gs).groups.values()]);
  });
});

describe('engine with a routed travel model', () => {
  it('uses per-pair travel times: a slow road makes a close center unreachable, a fast one rescues a far one', () => {
    const matrixLike = {
      name: 'test-matrix',
      // city "a" -> center 1 (close by air, 3 h by road) and center 2 (farther by air, 20 min by road)
      minutes: (_from: unknown, to: { id: number }) => (to.id === 1 ? 180 : 20),
    };
    const e = new UtilizationEngine([center(1, 15.01), center(2, 15.2)], { ...opts, travel: matrixLike });
    const r = e.run([group('a', 15.0, 5)]);
    expect(r.centers.get(1)!.demand).toBe(0);
    expect(r.centers.get(2)!.demand).toBe(5);
    expect(r.groups.get('a')!.flagged).toBe(0);
  });

  it('passes the city key to the model so a matrix can be looked up', () => {
    const seen: Array<string | null> = [];
    const spy = {
      name: 'spy',
      minutes: (from: { key: string | null }) => {
        seen.push(from.key);
        return 10;
      },
    };
    new UtilizationEngine([center(1, 15.01)], { ...opts, travel: spy }).run([group('zzz', 15.0, 1)]);
    expect(seen).toContain('zzz');
  });
});
