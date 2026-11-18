import { DataSource } from 'typeorm';
import { haversineKm } from '../common/geo/haversine';
import { median } from '../common/robust-stats';
import { CityContext, decideRecovery, ExcludedCenter, normalizeName } from './center-recovery';

/** An excluded center as the recovery check reads it. */
export interface ExcludedRow {
  id: number;
  name: string;
  lat: number;
  lon: number;
  coord_status: string;
  is_foreign: boolean;
  is_hidden: boolean;
  is_closed: boolean;
  /** false = not in the TESDA API's list, which the analysis uses */
  tesda_listed: boolean | null;
  city_id: number | null;
  province_psgc: string | null;
  region_psgc: string | null;
  island_id: number | null;
  source_city_name: string | null;
  source_province_name: string | null;
  in_province_psgc: string | null;
  in_province: string | null;
  in_region_psgc: string | null;
}

export interface RecoveryVerdict {
  row: ExcludedRow;
  recover: boolean;
  method?: string;
  evidence?: Record<string, unknown>;
  reason?: string;
  cityId: number | null;
  islandId: number | null;
}

export interface RecoveryAssessment {
  /** centers in the data / in the analysis */
  total: number;
  analysed: number;
  /** excluded on purpose (not listed, foreign, hidden, closed): never tested */
  deliberate: ExcludedRow[];
  /** one verdict per center excluded for a data problem */
  verdicts: RecoveryVerdict[];
}

/** True when a center is out of the analysis by choice, not because of its data. */
export const excludedOnPurpose = (r: ExcludedRow) => r.tesda_listed === false || r.is_foreign || r.is_hidden || r.is_closed;

/**
 * Test every center left out of the analysis for a data problem (disputed coordinates, no city or province link)
 * with `decideRecovery`. Changes nothing. Centers already in center_recovery_log are skipped.
 */
export async function assessExcludedCenters(ds: DataSource): Promise<RecoveryAssessment> {
  const [{ ok }] = await ds.query(`SELECT to_regclass('public.center_recovery_log') IS NOT NULL AS ok`);
  if (!ok) throw new Error('center_recovery_log is missing: run `npm run db:migrate` first');

  const [{ analysed, total }] = await ds.query(
    `SELECT count(*) FILTER (WHERE include_in_analysis)::int AS analysed, count(*)::int AS total FROM assessment_centers`,
  );
  const excluded: ExcludedRow[] = await ds.query(
    `SELECT a.id, a.name, a.lat, a.lon, a.coord_status, a.is_foreign, a.is_hidden, a.is_closed, a.tesda_listed, a.city_id, a.province_psgc,
            a.region_psgc, a.island_id, a.source_city_name, a.source_province_name,
            prov.psgc AS in_province_psgc, prov.name AS in_province, prov.region_psgc AS in_region_psgc
       FROM assessment_centers a
       LEFT JOIN LATERAL (SELECT p.psgc, p.name, p.region_psgc FROM provinces p WHERE ST_Intersects(p.geom, a.location) LIMIT 1) prov ON true
      WHERE NOT a.include_in_analysis AND NOT EXISTS (SELECT 1 FROM center_recovery_log l WHERE l.center_id = a.id)`,
  );
  const deliberate = excluded.filter(excludedOnPurpose);
  const testable = excluded.filter((r) => !excludedOnPurpose(r));
  if (!testable.length) return { total, analysed, deliberate, verdicts: [] };

  const cities: Array<{ id: number; key: string; name: string; province_psgc: string; island_id: number | null; lon: number; lat: number }> =
    await ds.query(`SELECT id, key, name, province_psgc, island_id, ST_X(centroid) AS lon, ST_Y(centroid) AS lat FROM cities`);
  const peerRows: Array<{ city_id: number; km: number }> = await ds.query(
    `SELECT a.city_id, ST_Distance(a.location::geography, ci.centroid::geography) / 1000 AS km
       FROM assessment_centers a JOIN cities ci ON ci.id = a.city_id WHERE a.include_in_analysis`,
  );
  const peers = new Map<number, number[]>();
  for (const p of peerRows) peers.set(p.city_id, [...(peers.get(p.city_id) ?? []), p.km]);

  // Excluded centers whose source city has no row in the cities table are judged as a group (e.g. Bacolod City).
  const matchOf = (r: ExcludedRow) =>
    cities.find((c) => c.province_psgc === r.in_province_psgc && normalizeName(c.name) === normalizeName(r.source_city_name)) ?? null;
  const groups = new Map<string, ExcludedRow[]>();
  for (const r of testable) {
    if (!matchOf(r)) {
      const k = `${normalizeName(r.source_city_name)}|${r.in_province_psgc}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
  }

  const verdicts: RecoveryVerdict[] = [];
  for (const r of testable) {
    const city = matchOf(r);
    const member = groups.get(`${normalizeName(r.source_city_name)}|${r.in_province_psgc}`) ?? [];
    const mlat = median(member.map((m) => m.lat));
    const mlon = median(member.map((m) => m.lon));
    const ex: ExcludedCenter = {
      id: r.id,
      lat: r.lat,
      lon: r.lon,
      sourceCityName: r.source_city_name,
      sourceProvinceName: r.source_province_name,
      insideProvince: r.in_province,
    };
    const ctx: CityContext = {
      matchedCity: city ? { id: city.id, name: city.name } : null,
      peerDistancesKm: city ? (peers.get(city.id) ?? []) : [],
      distanceToCityKm: city ? haversineKm(r.lat, r.lon, city.lat, city.lon) : null,
      clusterDistancesKm: city ? [] : member.map((m) => haversineKm(m.lat, m.lon, mlat, mlon)),
      distanceToClusterKm: city || !member.length ? null : haversineKm(r.lat, r.lon, mlat, mlon),
    };
    const d = decideRecovery(ex, ctx);
    let islandId = city?.island_id ?? null;
    if (d.recover && islandId === null && r.in_province_psgc) {
      const [n] = await ds.query(
        `SELECT island_id FROM cities WHERE province_psgc = $1 ORDER BY centroid <-> ST_SetSRID(ST_MakePoint($2, $3), 4326) LIMIT 1`,
        [r.in_province_psgc, r.lon, r.lat],
      );
      islandId = n?.island_id ?? null;
    }
    verdicts.push({
      row: r,
      recover: d.recover,
      method: d.recover ? d.method : undefined,
      evidence: d.recover ? d.evidence : undefined,
      reason: d.recover ? undefined : d.reason,
      cityId: city?.id ?? null,
      islandId,
    });
  }
  return { total, analysed, deliberate, verdicts };
}

/** Put the centers that passed back in the analysis, logging each change in center_recovery_log (one transaction). */
export async function applyRecovery(ds: DataSource, verdicts: RecoveryVerdict[]): Promise<number[]> {
  const saved = verdicts.filter((v) => v.recover);
  if (!saved.length) return [];
  await ds.transaction(async (m) => {
    for (const v of saved) {
      const r = v.row;
      const before = { include_in_analysis: false, coord_status: r.coord_status, city_id: r.city_id, province_psgc: r.province_psgc, region_psgc: r.region_psgc, island_id: r.island_id };
      const after = { include_in_analysis: true, coord_status: r.coord_status === 'disputed' ? 'recovered_disputed' : r.coord_status, city_id: v.cityId, province_psgc: r.in_province_psgc, region_psgc: r.in_region_psgc, island_id: v.islandId };
      await m.query(`INSERT INTO center_recovery_log (center_id, method, evidence, before, after) VALUES ($1, $2, $3, $4, $5)`, [
        r.id,
        v.method,
        JSON.stringify(v.evidence),
        JSON.stringify(before),
        JSON.stringify(after),
      ]);
      await m.query(
        `UPDATE assessment_centers SET include_in_analysis = true, coord_status = $2, city_id = $3, province_psgc = $4, region_psgc = $5, island_id = $6 WHERE id = $1`,
        [r.id, after.coord_status, after.city_id, after.province_psgc, after.region_psgc, after.island_id],
      );
    }
  });
  return saved.map((v) => v.row.id);
}

/** Undo every logged recovery. Returns how many centers were put back. */
export async function revertRecovery(ds: DataSource): Promise<number> {
  const rows: Array<{ center_id: number; before: Record<string, unknown> }> = await ds.query(`SELECT center_id, before FROM center_recovery_log`);
  await ds.transaction(async (m) => {
    for (const r of rows) {
      const b = r.before;
      await m.query(
        `UPDATE assessment_centers SET include_in_analysis = $2, coord_status = $3, city_id = $4, province_psgc = $5, region_psgc = $6, island_id = $7 WHERE id = $1`,
        [r.center_id, b.include_in_analysis, b.coord_status, b.city_id, b.province_psgc, b.region_psgc, b.island_id],
      );
    }
    await m.query(`DELETE FROM center_recovery_log`);
  });
  return rows.length;
}
