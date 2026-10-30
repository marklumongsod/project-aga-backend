import { RawStep } from './osrm.client';
import { bearingDeg, describeStep, toRouteSteps, walkSteps } from './route-instructions';

const step = (maneuver: Partial<RawStep['maneuver']> & { type: string }, name = '', mode = 'driving', distance = 100, duration = 30): RawStep => ({
  distance,
  duration,
  name,
  mode,
  maneuver: { location: [123, 10], ...maneuver },
});

describe('describeStep', () => {
  it('departs in a compass direction on the named road', () => {
    expect(describeStep(step({ type: 'depart', bearing_after: 92 }, 'Rizal Street'))).toBe('Head east on Rizal Street');
    expect(describeStep(step({ type: 'depart', bearing_after: 355 }))).toBe('Head north');
  });

  it('turns, with or without a road name', () => {
    expect(describeStep(step({ type: 'turn', modifier: 'left' }, 'Mabini Avenue'))).toBe('Turn left onto Mabini Avenue');
    expect(describeStep(step({ type: 'turn', modifier: 'sharp right' }))).toBe('Make a sharp right');
    expect(describeStep(step({ type: 'turn', modifier: 'slight left' }, 'National Road'))).toBe('Bear left onto National Road');
    expect(describeStep(step({ type: 'turn', modifier: 'uturn' }))).toBe('Make a U-turn');
  });

  it('continues, merges and takes ramps', () => {
    expect(describeStep(step({ type: 'new name' }, 'Cebu South Road'))).toBe('Continue onto Cebu South Road');
    expect(describeStep(step({ type: 'continue', modifier: 'straight' }, 'Osmeña Boulevard'))).toBe('Continue straight on Osmeña Boulevard');
    expect(describeStep(step({ type: 'merge', modifier: 'slight right' }, 'SLEX'))).toBe('Merge right onto SLEX');
    expect(describeStep(step({ type: 'off ramp', modifier: 'slight right' }, 'Exit 12'))).toBe('Take the exit on the right onto Exit 12');
    expect(describeStep(step({ type: 'fork', modifier: 'slight left' }))).toBe('Keep left at the fork');
  });

  it('describes roundabouts with the exit number', () => {
    expect(describeStep(step({ type: 'roundabout', exit: 2 }, 'Quezon Avenue'))).toBe('At the roundabout, take the second exit onto Quezon Avenue');
    expect(describeStep(step({ type: 'exit roundabout' }, 'Quezon Avenue'))).toBe('Exit the roundabout onto Quezon Avenue');
  });

  it('says where the destination is on arrival', () => {
    expect(describeStep(step({ type: 'arrive', modifier: 'right' }))).toBe('You have arrived. Your destination is on the right');
    expect(describeStep(step({ type: 'arrive' }))).toBe('You have arrived at your destination');
  });

  it('names the ferry', () => {
    expect(describeStep(step({ type: 'turn', modifier: 'left' }, 'Hagnaya - Bantayan', 'ferry'))).toBe('Take the ferry (Hagnaya - Bantayan)');
    expect(describeStep(step({ type: 'turn' }, '', 'ferry'))).toBe('Take the ferry');
  });
});

describe('toRouteSteps', () => {
  it('drops zero-length notifications and merges consecutive ferry legs', () => {
    const out = toRouteSteps([
      step({ type: 'depart', bearing_after: 0 }, 'A', 'driving', 500, 60),
      step({ type: 'notification' }, '', 'driving', 0, 0),
      step({ type: 'turn', modifier: 'left' }, 'Port Road', 'ferry', 8000, 3600),
      step({ type: 'notification' }, 'Port Road', 'ferry', 2000, 600),
      step({ type: 'arrive' }, '', 'driving', 0, 0),
    ]);
    expect(out.map((s) => s.mode)).toEqual(['driving', 'ferry', 'driving']);
    expect(out[1]).toMatchObject({ distanceM: 10000, minutes: 70 });
    expect(out[0]!.instruction).toBe('Head north on A');
  });
});

describe('walking directions', () => {
  const a = { lat: 14.521465, lon: 121.029221 };
  const b = { lat: 14.51952, lon: 121.0296 };

  it('gives a compass bearing', () => {
    expect(bearingDeg({ lat: 10, lon: 123 }, { lat: 11, lon: 123 })).toBeCloseTo(0, 3); // north
    expect(bearingDeg({ lat: 10, lon: 123 }, { lat: 10, lon: 124 })).toBeCloseTo(90, 0); // east
    expect(bearingDeg({ lat: 10, lon: 123 }, { lat: 9, lon: 123 })).toBeCloseTo(180, 3); // south
  });

  it('turns a short trip into one walking leg plus arrival', () => {
    const { steps, minutes } = walkSteps(a, b, 220);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ mode: 'walking', instruction: 'Walk about 220 m south to the center', distanceM: 220 });
    expect(steps[1]!.instruction).toBe('You have arrived at your destination');
    expect(minutes).toBe(4); // 220 m x 1.3 / 80 m per min = 3.6
  });

  it('says so when you are already there', () => {
    const { steps, minutes } = walkSteps(a, a, 3);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.instruction).toBe("You are already at the center's location");
    expect(minutes).toBe(1);
  });
});
