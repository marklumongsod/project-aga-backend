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
): Promise<{ bands: Array<Feature<Polygon | MultiPolygon, { band: number; fromMinutes: number; toMinutes: number }>>; limit: Feature<Polygon | MultiPolygon> | null; points: number; reached: number }> {
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
  inside.forEach((gi, k) => {
    const m = minutes[k];
    if (m !== null && m !== undefined && Number.isFinite(m)) {
      grid.features[gi]!.properties = { minutes: m };
      reached++;
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
  return { bands: out, limit, points: inside.length, reached };
}
