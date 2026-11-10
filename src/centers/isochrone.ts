import isobands from '@turf/isobands';
import pointGrid from '@turf/point-grid';
import union from '@turf/union';
import { featureCollection } from '@turf/helpers';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { haversineKm } from '../common/geo/haversine';

export interface IsochroneOptions {
  /** how far around the center to look, km (the grid is clipped to this circle) */
  radiusKm: number;
  /** grid spacing, km: smaller = smoother contours, more routing calls */
  spacingKm: number;
  /** travel-time breaks in minutes, ascending, e.g. [30, 60, 90] */
  breaks: number[];
}

export interface Pt {
  lon: number;
  lat: number;
}

/** Minutes from each point to the center, null = unreachable (no road, or in the sea). One entry per input point. */
export type TravelMinutes = (points: Pt[]) => Promise<Array<number | null>>;

const UNREACHABLE = 1_000_000;

/**
 * True isochrones: travel-time polygons around a center. A regular grid of points around it is routed to the center
 * (road + ferry), and contour bands are drawn through those times. Band i covers [breaks[i-1], breaks[i]] minutes.
 * Also returns `limit`: everything within the last break, as one outline.
 */
export async function buildIsochrones(
  center: Pt,
  opts: IsochroneOptions,
  travel: TravelMinutes,
): Promise<{
  bands: Array<Feature<Polygon | MultiPolygon, { band: number; fromMinutes: number; toMinutes: number }>>;
  limit: Feature<Polygon | MultiPolygon> | null;
  points: number;
  reached: number;
  /** every routed grid point within the last break: [lon, lat, minutes] (the map draws them as a smooth field) */
  samples: Array<[number, number, number]>;
}> {
  const dLat = opts.radiusKm / 111.195;
  const dLon = opts.radiusKm / (111.195 * Math.cos((center.lat * Math.PI) / 180));
  const grid = pointGrid([center.lon - dLon, center.lat - dLat, center.lon + dLon, center.lat + dLat], opts.spacingKm, { units: 'kilometers' });

  const inside: number[] = [];
  grid.features.forEach((f, i) => {
    const [lon, lat] = f.geometry.coordinates as [number, number];
    f.properties = { minutes: UNREACHABLE };
    if (haversineKm(center.lat, center.lon, lat, lon) <= opts.radiusKm) inside.push(i);
  });
  const minutes = await travel(inside.map((i) => ({ lon: grid.features[i]!.geometry.coordinates[0]!, lat: grid.features[i]!.geometry.coordinates[1]! })));
  let reached = 0;
  const samples: Array<[number, number, number]> = [];
  const last = opts.breaks[opts.breaks.length - 1]!;
  inside.forEach((gi, k) => {
    const m = minutes[k];
    if (m !== null && m !== undefined && Number.isFinite(m)) {
      grid.features[gi]!.properties = { minutes: m };
      reached++;
      if (m <= last) {
        const [lon, lat] = grid.features[gi]!.geometry.coordinates as [number, number];
        samples.push([Math.round(lon * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4, Math.round(m * 10) / 10]);
      }
    }
  });

  const edges = [0, ...opts.breaks];
  const bands = isobands(grid, edges, { zProperty: 'minutes' }) as FeatureCollection<MultiPolygon>;
  const out = bands.features
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.geometry.coordinates.length > 0)
    .map(({ f, i }) => ({
      type: 'Feature' as const,
      geometry: f.geometry as Polygon | MultiPolygon,
      properties: { band: i, fromMinutes: edges[i]!, toMinutes: edges[i + 1]! },
    }));

  let limit: Feature<Polygon | MultiPolygon> | null = null;
  if (out.length) limit = out.length === 1 ? out[0]! : union(featureCollection(out as Array<Feature<Polygon | MultiPolygon>>));
  return { bands: out, limit, points: inside.length, reached, samples };
}

/** The routing call routedIsochrones needs: minutes from each source to one destination, and how far each source snapped. */
export type RouteTable = (sources: Pt[], destinations: Pt[]) => Promise<{ minutes: Array<Array<number | null>>; sourceSnapM?: number[] } | null>;

/**
 * Drive-time isochrones around `origin` for a travel limit: thirds of the limit as bands, plus the limit's outline.
 * The grid covers the search radius (`searchKm`, a little wider), with a spacing that keeps it near ~5,000 routed
 * points for any limit; a point farther from a road than about one grid step is sea, not reachable. null when routing
 * fails.
 */
export async function routedIsochrones(origin: Pt, limitMinutes: number, searchKm: number, table: RouteTable) {
  const radiusKm = Math.ceil(searchKm * 1.05);
  const spacingKm = Math.max(1.5, Math.round((radiusKm / 36) * 10) / 10);
  const maxSnapM = spacingKm * 1000 * 1.2;
  const breaks = [limitMinutes / 3, (2 * limitMinutes) / 3, limitMinutes];
  let failed = false;
  const built = await buildIsochrones(origin, { radiusKm, spacingKm, breaks }, async (pts) => {
    const t = await table(pts, [origin]);
    if (!t) {
      failed = true;
      return pts.map(() => null);
    }
    return pts.map((_, i) => {
      const snap = t.sourceSnapM?.[i] ?? 0;
      const m = t.minutes[i]?.[0];
      return m === null || m === undefined || snap > maxSnapM ? null : m;
    });
  });
  if (failed) return null;
  return {
    radiusKm,
    spacingKm,
    breaks,
    built,
    features: [
      ...built.bands.map((b) => ({ ...b, properties: { kind: 'band' as const, ...b.properties } })),
      ...(built.limit ? [{ ...built.limit, properties: { kind: 'limit' as const, toMinutes: limitMinutes } }] : []),
    ],
  };
}
