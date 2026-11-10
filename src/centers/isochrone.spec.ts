import area from '@turf/area';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point } from '@turf/helpers';
import { haversineKm } from '../common/geo/haversine';
import { buildIsochrones, Pt } from './isochrone';

const center: Pt = { lon: 123.07, lat: 10.67 };
/** a fake road network: straight lines at 40 km/h (1.5 min per km) */
const flat = async (pts: Pt[]) => pts.map((p) => haversineKm(center.lat, center.lon, p.lat, p.lon) * 1.5);
const opts = { radiusKm: 75, spacingKm: 2, breaks: [30, 60, 90] };
const km2 = (m2: number) => m2 / 1e6;

describe('buildIsochrones', () => {
  it('draws nested bands whose outer edges are where the travel time reaches each break', async () => {
    const r = await buildIsochrones(center, opts, flat);
    expect(r.bands.map((b) => b.properties.band)).toEqual([0, 1, 2]);
    expect(r.bands.map((b) => [b.properties.fromMinutes, b.properties.toMinutes])).toEqual([[0, 30], [30, 60], [60, 90]]);
    // 30 / 60 / 90 min at 1.5 min per km = circles of 20 / 40 / 60 km radius
    const disc = (radius: number) => Math.PI * radius * radius;
    const within = (got: number, want: number) => expect(Math.abs(got - want) / want).toBeLessThan(0.06); // within 6% (grid of 2 km)
    within(km2(area(r.bands[0]!)), disc(20));
    within(km2(area(r.bands[1]!)), disc(40) - disc(20)); // rings, not discs: bands don't overlap
    within(km2(area(r.bands[2]!)), disc(60) - disc(40));
    within(km2(area(r.limit!)), disc(60)); // the outline of everything within 90 minutes
  });

  it('puts the center in the first band and a point beyond 90 minutes outside every band', async () => {
    const r = await buildIsochrones(center, opts, flat);
    expect(booleanPointInPolygon(point([center.lon, center.lat]), r.bands[0]!)).toBe(true);
    const far = point([center.lon + 70 / (111.195 * Math.cos((center.lat * Math.PI) / 180)), center.lat]); // ~70 km east: 105 min
    expect(r.bands.some((b) => booleanPointInPolygon(far, b))).toBe(false);
    expect(booleanPointInPolygon(far, r.limit!)).toBe(false);
  });

  it('returns the timed points within the limit for the smooth reach field, and none at sea', async () => {
    const sea = async (pts: Pt[]) => pts.map((p) => (p.lon > center.lon ? null : haversineKm(center.lat, center.lon, p.lat, p.lon) * 1.5));
    const r = await buildIsochrones(center, opts, sea);
    expect(r.samples.length).toBeGreaterThan(100);
    for (const [lon, lat, m] of r.samples) {
      expect(m).toBeLessThanOrEqual(90);
      expect(lon).toBeLessThanOrEqual(center.lon); // the eastern half is sea
      expect(Math.abs(m - haversineKm(center.lat, center.lon, lat, lon) * 1.5)).toBeLessThan(0.2); // its own routed minutes
    }
  });

  it('leaves out unreachable points (the sea): a half-plane of water shrinks the area to about half', async () => {
    const sea = async (pts: Pt[]) => pts.map((p) => (p.lon > center.lon ? null : haversineKm(center.lat, center.lon, p.lat, p.lon) * 1.5));
    const full = await buildIsochrones(center, opts, flat);
    const half = await buildIsochrones(center, opts, sea);
    const ratio = km2(area(half.limit!)) / km2(area(full.limit!));
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.6);
    expect(half.reached).toBeLessThan(full.reached);
  });

  it('returns no polygons when nothing is reachable (an island with no road)', async () => {
    const r = await buildIsochrones(center, opts, async (pts) => pts.map(() => null));
    expect(r.bands).toEqual([]);
    expect(r.limit).toBeNull();
    expect(r.reached).toBe(0);
  });

  it('asks the router for points inside the radius only, once', async () => {
    let calls = 0;
    let asked = 0;
    await buildIsochrones(center, opts, async (pts) => {
      calls++;
      asked = pts.length;
      expect(pts.every((p) => haversineKm(center.lat, center.lon, p.lat, p.lon) <= opts.radiusKm)).toBe(true);
      return pts.map(() => 10);
    });
    expect(calls).toBe(1);
    expect(asked).toBeGreaterThan(4000); // ~ pi x 75^2 / 2^2 = 4,418 grid points
    expect(asked).toBeLessThan(4800);
  });
});
