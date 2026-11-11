/**
 * Loads database/seed-data/*.json (built by etl/build_seed.py) into PostgreSQL.
 * Idempotent: reference tables are truncated and reloaded in one transaction;
 * demo office accounts are upserted. Simulation results are left alone.
 *
 *   npm run db:seed
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as bcrypt from 'bcryptjs';
import { DataSource, QueryRunner } from 'typeorm';
import { typeormOptions } from './data-source';

const DATA_DIR = join(__dirname, '..', '..', 'database', 'seed-data');
const load = <T>(file: string): T[] => JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8')) as T[];
/** Dates in the seed JSON are epoch seconds and are stored as epoch seconds (team convention). */
const date = (epoch: number | null | undefined): number | null => (epoch == null ? null : Math.floor(epoch));

type Row = Record<string, unknown>;

/** Batched multi-row INSERT. Columns listed in `geom` are GeoJSON objects stored as PostGIS geometry. */
async function insert(
  qr: QueryRunner,
  table: string,
  columns: string[],
  rows: Row[],
  geom: string[] = [],
  batch = 500,
) {
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => {
      const ph = columns.map((c) => {
        params.push(geom.includes(c) ? (row[c] == null ? null : JSON.stringify(row[c])) : row[c]);
        const p = `$${params.length}`;
        return geom.includes(c) ? `ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${p}), 4326))` : p;
      });
      return `(${ph.join(', ')})`;
    });
    const cols = columns.map((c) => `"${c}"`).join(', ');
    await qr.query(`INSERT INTO "${table}" (${cols}) VALUES ${tuples.join(', ')}`, params);
  }
}

async function main() {
  const ds = await new DataSource(typeormOptions()).initialize();
  const qr = ds.createQueryRunner();
  await qr.connect();
  await qr.startTransaction();
  try {
    // The centers are about to be reloaded as the source data has them, so the log of recovered centers no longer applies.
    await qr.query(`DELETE FROM center_recovery_log`);
    // TESDA API data (center_qualifications, upcoming_graduates) goes too: `npm run tesda:sync` reloads it on top of the seed.
    // So does the sync log, or the next sync would think the reseeded centers are already up to date and skip.
    await qr.query(`TRUNCATE center_utilization, area_utilization, simulation_runs, center_qualifications, upcoming_graduates,
      tesda_syncs, assessment_centers, cities, provinces RESTART IDENTITY CASCADE`);
    await qr.query(
      `DELETE FROM users WHERE region_psgc IS NOT NULL OR province_psgc IS NOT NULL OR role = 'CO'`,
    );
    await qr.query(`DELETE FROM regions`);

    // geography
    const regions = load<Row>('regions.json');
    await insert(
      qr,
      'regions',
      ['psgc', 'name', 'geom'],
      regions.map((r) => ({ ...r, geom: r.geometry })),
      ['geom'],
      5,
    );
    const provinces = load<Row>('provinces.json');
    await insert(
      qr,
      'provinces',
      ['psgc', 'name', 'region_psgc', 'geom'],
      provinces.map((p) => ({ psgc: p.psgc, name: p.name, region_psgc: p.regionPsgc, geom: p.geometry })),
      ['geom'],
      20,
    );
    const cities = load<Row>('cities.json');
    await insert(
      qr,
      'cities',
      [
        'key',
        'psgc',
        'name',
        'province_psgc',
        'region_psgc',
        'derived_boundary',
        'island_id',
        'lat',
        'lon',
        'geom',
      ],
      cities.map((c) => ({
        key: c.key,
        psgc: c.psgc,
        name: c.name,
        province_psgc: c.provincePsgc,
        region_psgc: c.regionPsgc,
        derived_boundary: c.derivedBoundary,
        island_id: c.islandId,
        lat: c.lat,
        lon: c.lon,
        geom: c.geometry,
      })),
      ['geom'],
      100,
    );
    await qr.query(`UPDATE cities SET centroid = ST_SetSRID(ST_MakePoint(lon, lat), 4326)`);
    const cityId = new Map<string, number>(
      (await qr.query(`SELECT id, key FROM cities`)).map((r: { id: number; key: string }) => [r.key, r.id]),
    );

    // Assessment centers come from the TESDA API (`npm run tesda:sync`, part of db:setup). Only the centers whose position
    // Team C corrected by hand are seeded, so the sync keeps that position over the API's raw point. They join the
    // analysis once the sync has listed them.
    await insert(
      qr,
      'assessment_centers',
      [
        'id',
        'name',
        'address',
        'phone',
        'email',
        'district',
        'source_region_name',
        'source_province_name',
        'source_city_name',
        'lat',
        'lon',
        'coord_status',
        'coord_source',
        'is_foreign',
        'is_closed',
        'is_hidden',
        'include_in_analysis',
        'city_id',
        'province_psgc',
        'region_psgc',
        'island_id',
        'created_at',
      ],
      load<Row>('center_corrections.json').map((c) => ({
        id: c.id,
        name: c.name,
        address: c.address,
        phone: c.phone,
        email: c.email,
        district: c.district,
        source_region_name: c.sourceRegionName,
        source_province_name: c.sourceProvinceName,
        source_city_name: c.sourceCityName,
        lat: c.lat,
        lon: c.lon,
        coord_status: c.coordStatus,
        coord_source: c.coordSource,
        is_foreign: c.isForeign,
        is_closed: c.isClosed,
        is_hidden: c.isHidden,
        include_in_analysis: false,
        city_id: c.cityKey ? (cityId.get(c.cityKey as string) ?? null) : null,
        province_psgc: c.provincePsgc,
        region_psgc: c.regionPsgc,
        island_id: c.islandId,
        created_at: date(c.createdAt as number),
      })),
    );
    await qr.query(`UPDATE assessment_centers SET location = ST_SetSRID(ST_MakePoint(lon, lat), 4326)`);

    // Candidates are not seeded: they are the upcoming TESDA graduates, loaded by `npm run tesda:sync`.

    // demo office accounts (no self sign-up; real accounts come from T2MIS)
    const pw = process.env.SEED_DEMO_PASSWORD;
    if (pw) {
      const hash = await bcrypt.hash(pw, 12);
      const users = [
        {
          email: 'co.planning@demo.aga.local',
          name: 'Planning Office (demo)',
          role: 'CO',
          region_psgc: null,
          province_psgc: null,
        },
        {
          email: 'ro.region6@demo.aga.local',
          name: 'Regional Office VI (demo)',
          role: 'RO',
          region_psgc: '0600000000',
          province_psgc: null,
        },
        {
          email: 'po.negrosoccidental@demo.aga.local',
          name: 'Provincial Office Negros Occidental (demo)',
          role: 'PO',
          region_psgc: '0600000000',
          province_psgc: '0604500000',
        },
      ];
      for (const u of users) {
        await qr.query(
          `INSERT INTO users (email, name, password_hash, role, region_psgc, province_psgc)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash,
             role = EXCLUDED.role, region_psgc = EXCLUDED.region_psgc, province_psgc = EXCLUDED.province_psgc`,
          [u.email, u.name, hash, u.role, u.region_psgc, u.province_psgc],
        );
      }
    }
    await qr.commitTransaction();
    const counts = await ds.query(`SELECT
      (SELECT count(*) FROM regions) regions, (SELECT count(*) FROM provinces) provinces, (SELECT count(*) FROM cities) cities,
      (SELECT count(*) FROM assessment_centers) centers, (SELECT count(*) FROM assessment_centers WHERE include_in_analysis) centers_in_analysis,
      (SELECT count(*) FROM users) users`);
    console.log('seeded', counts[0]);
  } catch (e) {
    await qr.rollbackTransaction();
    throw e;
  } finally {
    await qr.release();
    await ds.destroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
