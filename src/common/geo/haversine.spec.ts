import { EPSG_WGS84, haversineKm } from './haversine';

/** Reference distances from PostGIS `ST_Distance(geography)`, i.e. on the WGS84 ellipsoid (EPSG:4326), in km. */
const POSTGIS_KM: Array<[string, [number, number], [number, number], number]> = [
  ['Manila - Cebu City', [14.5995, 120.9842], [10.3157, 123.8854], 569.2182],
  ['Davao - Zamboanga', [7.1907, 125.4553], [6.9214, 122.079], 374.2062],
  ['Laoag - Sanchez Mira (a km-limit sized trip)', [18.1978, 120.596], [18.578, 121.24], 80.0125],
  ['Tawi-Tawi - Batanes (the length of the country)', [5.03, 119.95], [20.45, 121.96], 1719.7929],
];

describe('haversineKm (team doc) on WGS84 / EPSG:4326', () => {
  it('uses EPSG:4326', () => expect(EPSG_WGS84).toBe(4326));

  it.each(POSTGIS_KM)('%s agrees with the ellipsoidal distance within 0.6%%', (_name, a, b, ellipsoidKm) => {
    const km = haversineKm(a[0], a[1], b[0], b[1]);
    expect(Math.abs(km - ellipsoidKm) / ellipsoidKm).toBeLessThan(0.006);
  });

  it('is zero for the same point, symmetric, and takes (lat, lon) in that order', () => {
    expect(haversineKm(10, 123, 10, 123)).toBe(0);
    expect(haversineKm(10, 123, 11, 124)).toBeCloseTo(haversineKm(11, 124, 10, 123), 9);
    // one degree of latitude is about 111 km; one degree of longitude at 10 degrees north is about 109.5 km
    expect(haversineKm(10, 123, 11, 123)).toBeCloseTo(111.2, 1);
    expect(haversineKm(10, 123, 10, 124)).toBeCloseTo(109.5, 1);
  });
});
