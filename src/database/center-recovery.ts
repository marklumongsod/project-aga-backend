import { robustLimit, median } from '../common/robust-stats';

/** "Zamboanga City" and "City of Zamboanga" are the same place; so are "Isabela" and "City of Isabela (Not a Province)". */
export function normalizeName(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(city of|municipality of|province of|city|municipality)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface ExcludedCenter {
  id: number;
  lat: number;
  lon: number;
  sourceCityName: string | null;
  sourceProvinceName: string | null;
  /** the province whose polygon contains the coordinates, if any */
  insideProvince: string | null;
}

export interface CityContext {
  /** a city of that province whose name matches the source city name, if the cities table has one */
  matchedCity: { id: number; name: string } | null;
  /** km from the other (valid) centers of the matched city to its centre */
  peerDistancesKm: number[];
  /** km from this center to the matched city's centre */
  distanceToCityKm: number | null;
  /** other excluded centers with the same source city and province, with their km distance to the group's median point */
  clusterDistancesKm: number[];
  /** this center's km distance to that group's median point */
  distanceToClusterKm: number | null;
}

export type Decision =
  | { recover: true; method: 'city_statistics' | 'cluster_statistics' | 'province_only'; evidence: Record<string, unknown> }
  | { recover: false; reason: string };

/** A tiny group has no spread worth measuring: don't pretend to a statistic. */
const MIN_PEERS = 5;

/**
 * Can this excluded center be saved? Three independent checks must agree:
 *   1. the coordinates fall inside a province, and it is the province the source record names;
 *   2. if the source city is in our cities table, the center sits no farther from its centre than the robust limit
 *      (median + 3 x MAD) of the city's other centers;
 *   3. if the city has no boundary (Bacolod...), the center sits with the other excluded centers of the same city
 *      (robust limit again); a lone center is accepted on check 1 alone and marked low confidence.
 */
export function decideRecovery(c: ExcludedCenter, ctx: CityContext): Decision {
  if (!c.insideProvince) return { recover: false, reason: 'the coordinates fall outside every province (at sea or abroad)' };
  if (normalizeName(c.insideProvince) !== normalizeName(c.sourceProvinceName)) {
    return {
      recover: false,
      reason: `the record says ${c.sourceProvinceName ?? 'no province'}, but the coordinates are in ${c.insideProvince}`,
    };
  }
  if (ctx.matchedCity) {
    const d = ctx.distanceToCityKm ?? Infinity;
    if (ctx.peerDistancesKm.length >= MIN_PEERS) {
      const limit = robustLimit(ctx.peerDistancesKm, 3, 1);
      return d <= limit
        ? {
            recover: true,
            method: 'city_statistics',
            evidence: {
              city: ctx.matchedCity.name,
              km_from_city_centre: round(d),
              peers: ctx.peerDistancesKm.length,
              peer_median_km: round(median(ctx.peerDistancesKm)),
              limit_km: round(limit),
            },
          }
        : { recover: false, reason: `${round(d)} km from the centre of ${ctx.matchedCity.name}; its other centers are within ${round(limit)} km` };
    }
    return d <= 10
      ? { recover: true, method: 'city_statistics', evidence: { city: ctx.matchedCity.name, km_from_city_centre: round(d), peers: ctx.peerDistancesKm.length, limit_km: 10 } }
      : { recover: false, reason: `${round(d)} km from the centre of ${ctx.matchedCity.name} and too few centers there to judge` };
  }
  // The source city has no row in the cities table.
  if (ctx.clusterDistancesKm.length >= 3 && ctx.distanceToClusterKm !== null) {
    const limit = robustLimit(ctx.clusterDistancesKm, 3, 2);
    return ctx.distanceToClusterKm <= limit
      ? {
          recover: true,
          method: 'cluster_statistics',
          evidence: {
            source_city: c.sourceCityName,
            group_size: ctx.clusterDistancesKm.length,
            km_from_group_median: round(ctx.distanceToClusterKm),
            limit_km: round(limit),
          },
        }
      : { recover: false, reason: `${round(ctx.distanceToClusterKm)} km from the other centers recorded in ${c.sourceCityName} (limit ${round(limit)} km)` };
  }
  return { recover: true, method: 'province_only', evidence: { source_city: c.sourceCityName, confidence: 'low', note: 'only the province could be checked' } };
}

const round = (n: number) => Math.round(n * 10) / 10;
