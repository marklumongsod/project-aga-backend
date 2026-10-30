/**
 * Coordinates everywhere in this project are WGS84 longitude/latitude in degrees, EPSG:4326: the SRID of every
 * PostGIS geometry column (a test checks it), and the order PostGIS wants is (lon, lat).
 */
export const EPSG_WGS84 = 4326;

/** IUGG mean Earth radius (km). */
const EARTH_RADIUS_KM = 6371.0088;

/**
 * Great-circle distance in km between two WGS84 (EPSG:4326) points: the team doc's Haversine.
 * It treats the Earth as a sphere, so it differs a little from PostGIS's ellipsoidal `geography` distance: measured on
 * 20,000 real city-center pairs in the Philippines, 0.26% on average and 0.55% at worst (0.27 km). The simulation's
 * km limit uses this; map queries use PostGIS.
 */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
