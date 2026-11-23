import { EstimatedTravelTimeModel } from '../travel/travel-time.model';
import { CapacityCenter, CapacityEngine } from './capacity-engine';
import { SimGroup } from './utilization-engine';

const travel = new EstimatedTravelTimeModel(1.35, 35, 90);
const opts = { limitMinutes: 90, searchKm: 113, travel };

const at = (lat: number, lon = 121) => ({ lat, lon });
const center = (id: number, lat: number, slots: number): CapacityCenter => ({ id, ...at(lat), islandId: 1, slots });
const group = (key: string, lat: number, count: number): SimGroup => ({ key, ...at(lat), islandId: 1, count });

describe('CapacityEngine (nearest center with an open slot)', () => {
  it('puts demand on the nearest open center and overflows to the next when it is full', () => {
    const e = new CapacityEngine([center(1, 15.0, 5), center(2, 15.1, 10)], opts);
    const r = e.run([group('a', 15.0, 12)]);

    expect(r.centers.get(1)).toMatchObject({ demand: 12, assigned: 5, slots: 5 });
    expect(r.centers.get(2)).toMatchObject({ demand: 0, assigned: 7, slots: 10 });
    expect(r.groups.get('a')).toMatchObject({ assigned: 12, flagged: 0 });
    expect(r.totals).toEqual({ candidates: 12, assigned: 12, flagged: 0 });
    // utilization is demand / slots, so it can exceed 100%
    expect(r.centers.get(1)!.demand / r.centers.get(1)!.slots).toBe(2.4);
  });

  it('moves demand to the next center when the nearest has no slots left', () => {
    const e = new CapacityEngine([center(1, 15.0, 0), center(2, 15.1, 4)], opts);
    const r = e.run([group('a', 15.0, 3)]);
    expect(r.centers.get(1)).toMatchObject({ demand: 0, assigned: 0, slots: 0 });
    expect(r.centers.get(2)).toMatchObject({ demand: 3, assigned: 3, slots: 4 });
  });

  it('flags candidates when every reachable center is full or has no slots', () => {
    const e = new CapacityEngine([center(1, 15.0, 0), center(2, 15.1, 2)], opts);
    const r = e.run([group('a', 15.0, 5)]);
    expect(r.centers.get(2)).toMatchObject({ demand: 5, assigned: 2 });
    expect(r.groups.get('a')).toMatchObject({ assigned: 2, flagged: 3 });
    expect(r.totals.flagged).toBe(3);
  });

  it('flags everyone when no center is in reach', () => {
    const e = new CapacityEngine([center(1, 15.4, 100)], opts); // ~103 minutes by the estimate
    const r = e.run([group('a', 15.0, 7)]);
    expect(r.groups.get('a')).toMatchObject({ assigned: 0, flagged: 7, nearestMinutes: null });
    expect(r.totals).toEqual({ candidates: 7, assigned: 0, flagged: 7 });
  });

  it('never assigns more than a center has slots, and is deterministic', () => {
    const centers = [center(1, 15.0, 3), center(2, 15.1, 4)];
    const groups = [group('b', 15.02, 4), group('a', 15.0, 6)];
    const first = new CapacityEngine(centers, opts).run(groups);
    const second = new CapacityEngine(centers, opts).run([...groups].reverse());
    expect([...first.centers.values()]).toEqual([...second.centers.values()]);
    for (const c of first.centers.values()) expect(c.assigned).toBeLessThanOrEqual(c.slots);
  });
});
