import { CityContext, decideRecovery, ExcludedCenter, normalizeName } from './center-recovery';

const center = (over: Partial<ExcludedCenter> = {}): ExcludedCenter => ({
  id: 1,
  lat: 10.66,
  lon: 122.94,
  sourceCityName: 'Bacolod City',
  sourceProvinceName: 'Negros Occidental',
  insideProvince: 'Negros Occidental',
  ...over,
});
const ctx = (over: Partial<CityContext> = {}): CityContext => ({
  matchedCity: null,
  peerDistancesKm: [],
  distanceToCityKm: null,
  clusterDistancesKm: [],
  distanceToClusterKm: null,
  ...over,
});

describe('normalizeName', () => {
  it('treats the same place written differently as equal', () => {
    expect(normalizeName('Zamboanga City')).toBe(normalizeName('City of Zamboanga'));
    expect(normalizeName('City of Isabela (Not a Province)')).toBe('isabela');
    expect(normalizeName('Negros Occidental')).toBe('negros occidental');
    expect(normalizeName(null)).toBe('');
    expect(normalizeName('Jala-Jala')).toBe('jala jala');
  });
});

describe('decideRecovery (can an excluded center be saved?)', () => {
  const peers = [0.6, 0.9, 1.4, 1.1, 0.8, 1.2, 0.7, 1.0]; // km of the city's other centers from its centre

  it('recovers a center that sits with the other centers of its matched city', () => {
    const d = decideRecovery(center({ sourceCityName: 'Zamboanga City', sourceProvinceName: 'Zamboanga del Sur', insideProvince: 'Zamboanga del Sur' }), ctx({ matchedCity: { id: 7, name: 'City of Zamboanga' }, peerDistancesKm: peers, distanceToCityKm: 1.6 }));
    expect(d).toMatchObject({ recover: true, method: 'city_statistics' });
  });

  it('keeps out a center far from where its city\'s other centers are', () => {
    const d = decideRecovery(center(), ctx({ matchedCity: { id: 7, name: 'City of Zamboanga' }, peerDistancesKm: peers, distanceToCityKm: 26 }));
    expect(d).toMatchObject({ recover: false });
    expect(!d.recover && d.reason).toContain('26 km');
  });

  it('keeps out a center whose coordinates are in a different province than the record says', () => {
    const d = decideRecovery(center({ sourceProvinceName: 'Zamboanga del Sur', sourceCityName: 'Zamboanga City', insideProvince: 'City of Isabela (Not a Province)' }), ctx());
    expect(d).toMatchObject({ recover: false });
    expect(!d.recover && d.reason).toContain('coordinates are in');
  });

  it('keeps out coordinates that are outside every province', () => {
    expect(decideRecovery(center({ insideProvince: null }), ctx())).toMatchObject({ recover: false });
  });

  it('recovers a member of a city with no boundary when it sits with the group (Bacolod)', () => {
    const d = decideRecovery(center(), ctx({ clusterDistancesKm: [0.3, 0.5, 0.2, 0.6, 0.4, 0.7], distanceToClusterKm: 0.5 }));
    expect(d).toMatchObject({ recover: true, method: 'cluster_statistics' });
  });

  it('keeps out a straggler of that group', () => {
    const d = decideRecovery(center(), ctx({ clusterDistancesKm: [0.3, 0.5, 0.2, 0.6, 0.4, 0.7], distanceToClusterKm: 18 }));
    expect(d).toMatchObject({ recover: false });
  });

  it('accepts a lone center on the province check alone, marked low confidence', () => {
    const d = decideRecovery(center({ sourceCityName: 'Jala-Jala', sourceProvinceName: 'Rizal', insideProvince: 'Rizal' }), ctx());
    expect(d).toMatchObject({ recover: true, method: 'province_only' });
    expect(d.recover && d.evidence.confidence).toBe('low');
  });

  it('with too few peers uses a flat 10 km, not a made-up statistic', () => {
    const near = decideRecovery(center(), ctx({ matchedCity: { id: 1, name: 'X' }, peerDistancesKm: [1, 2], distanceToCityKm: 8 }));
    const far = decideRecovery(center(), ctx({ matchedCity: { id: 1, name: 'X' }, peerDistancesKm: [1, 2], distanceToCityKm: 14 }));
    expect(near).toMatchObject({ recover: true });
    expect(far).toMatchObject({ recover: false });
  });
});
