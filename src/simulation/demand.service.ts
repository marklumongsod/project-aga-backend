import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SimGroup } from './engine/utilization-engine';
import { apportion, splitByGraduates } from './demand-split';
import { qualificationKey } from './qualification-need';

/** Where a city's candidate count comes from: measured, or filled in by splitting a larger total (see splitByGraduates). */
export type DemandSource = 'bsrs_city' | 'split_province' | 'split_district' | 'none';

export interface DemandGroup extends SimGroup {
  regionPsgc: string;
  provincePsgc: string;
  /** provenance of `count` (for the data-quality report); not used by the simulation */
  source?: DemandSource;
}

export interface CityRow {
  key: string;
  province_psgc: string;
  region_psgc: string;
  lat: number;
  lon: number;
  island_id: number;
}

/**
 * Candidates waiting for assessment, per city/municipality, from BSRS.
 *
 * Assumption (prototype): BSRS completed scholars = candidates for the current period.
 *   - a city-level BSRS row is used as is;
 *   - NCR is reported per district (CAMANAVA, PASMAK ...): split over the district's cities;
 *   - a province row minus its known cities is split over the province's other cities.
 * A split puts 20% of the total evenly and 80% by each town's upcoming TESDA graduates (upcoming_graduates, from the
 * API's students list, synced nightly; graduates the API places only in a province don't count), so a
 * city with the schools gets more than a small island town; an even split where there are no graduates at all.
 * Replace with T2MIS enrollee-candidate counts per city once they are loaded.
 */
/** One qualification's upcoming graduates, as the TESDA students list has them. */
export interface QualificationDemand {
  key: string;
  /** the name most graduates are listed under */
  name: string;
  ids: Set<number>;
  towns: Map<string, number>;
  provinces: Map<string, number>;
}

export interface QualificationCatalog {
  cities: CityRow[];
  byKey: Map<string, QualificationDemand>;
}

@Injectable()
export class DemandService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /** Upcoming graduates per qualification (matched by name, so "Driving II" and "DRIVING NC II" are one), counts only. */
  async qualificationCatalog(): Promise<QualificationCatalog> {
    const cities: CityRow[] = await this.db.query(`SELECT key, province_psgc, region_psgc, lat, lon, island_id FROM cities ORDER BY key`);
    const rows: Array<{ province_psgc: string; city_key: string | null; qualification: string; qualification_id: number | null; graduates: number }> = await this.db.query(
      `SELECT g.province_psgc, c.key AS city_key, g.qualification, g.qualification_id, sum(g.graduates)::int AS graduates
         FROM upcoming_graduates g LEFT JOIN cities c ON c.id = g.city_id
        GROUP BY 1, 2, 3, 4`,
    );
    const byKey = new Map<string, QualificationDemand>();
    const nameCount = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const key = qualificationKey(r.qualification);
      if (!key) continue;
      let q = byKey.get(key);
      if (!q) byKey.set(key, (q = { key, name: r.qualification, ids: new Set(), towns: new Map(), provinces: new Map() }));
      if (r.qualification_id !== null) q.ids.add(r.qualification_id);
      if (r.city_key) q.towns.set(r.city_key, (q.towns.get(r.city_key) ?? 0) + r.graduates);
      else q.provinces.set(r.province_psgc, (q.provinces.get(r.province_psgc) ?? 0) + r.graduates);
      const names = nameCount.get(key) ?? new Map<string, number>();
      names.set(r.qualification, (names.get(r.qualification) ?? 0) + r.graduates);
      nameCount.set(key, names);
    }
    for (const [key, names] of nameCount) byKey.get(key)!.name = [...names].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
    return { cities, byKey };
  }

  /**
   * One qualification's candidates per town: its upcoming graduates where the town is known. Graduates the API places
   * only in a province are split over that province's towns the usual way (`splitByGraduates`), and those towns are
   * marked as estimates.
   */
  qualificationGroups(cities: CityRow[], q: QualificationDemand): DemandGroup[] {
    const shares = new Map<string, number>(q.towns);
    const estimated = new Set<string>();
    for (const [province, total] of q.provinces) {
      const keys = cities.filter((c) => c.province_psgc === province).map((c) => c.key);
      for (const [k, v] of splitByGraduates(total, keys, q.towns)) {
        shares.set(k, (shares.get(k) ?? 0) + v);
        estimated.add(k);
      }
    }
    const count = apportion(shares);
    return cities
      .map((c) => ({
        key: c.key,
        lat: c.lat,
        lon: c.lon,
        islandId: c.island_id,
        regionPsgc: c.region_psgc,
        provincePsgc: c.province_psgc,
        count: count.get(c.key) ?? 0,
        source: estimated.has(c.key) ? ('split_province' as const) : ('bsrs_city' as const),
      }))
      .filter((g) => g.count > 0);
  }

  async currentGroups(): Promise<DemandGroup[]> {
    const cities: CityRow[] = await this.db.query(
      `SELECT key, province_psgc, region_psgc, lat, lon, island_id FROM cities ORDER BY key`,
    );
    const stats: Array<{
      level: string;
      province_psgc: string | null;
      city_key: string | null;
      city_keys: string[];
      completed: number;
    }> = await this.db.query(
      `SELECT level, province_psgc, city_key, city_keys, completed FROM bsrs_stats WHERE level IN ('PROVINCE','CITY')`,
    );

    const count = new Map<string, number>();
    const known = new Set<string>();
    const split = new Map<string, DemandSource>(); // cities whose count was filled in by an even split
    for (const s of stats) {
      if (s.level === 'CITY' && s.city_key) {
        count.set(s.city_key, (count.get(s.city_key) ?? 0) + s.completed);
        known.add(s.city_key);
      }
    }
    // upcoming TESDA graduates per town, all qualifications and months: where the province totals are split to
    const graduates = new Map<string, number>(
      (
        await this.db.query(
          `SELECT c.key, sum(g.graduates)::int AS graduates FROM upcoming_graduates g JOIN cities c ON c.id = g.city_id GROUP BY c.key`,
        )
      ).map((r: { key: string; graduates: number }) => [r.key, r.graduates]),
    );
    const byProvince = new Map<string, CityRow[]>();
    for (const c of cities) byProvince.set(c.province_psgc, [...(byProvince.get(c.province_psgc) ?? []), c]);

    for (const s of stats) {
      if (s.level !== 'PROVINCE') continue;
      let targets: string[];
      if (s.city_keys?.length) targets = s.city_keys;
      else if (s.province_psgc) targets = (byProvince.get(s.province_psgc) ?? []).map((c) => c.key);
      else continue;
      const knownSum = targets.filter((k) => known.has(k)).reduce((a, k) => a + (count.get(k) ?? 0), 0);
      const rest = targets.filter((k) => !known.has(k));
      if (!rest.length) continue;
      for (const [k, share] of splitByGraduates(Math.max(s.completed - knownSum, 0), rest, graduates)) {
        count.set(k, (count.get(k) ?? 0) + share);
        split.set(k, s.city_keys?.length ? 'split_district' : 'split_province');
      }
    }

    return cities
      .map((c) => ({
        key: c.key,
        lat: c.lat,
        lon: c.lon,
        islandId: c.island_id,
        regionPsgc: c.region_psgc,
        provincePsgc: c.province_psgc,
        count: Math.round(count.get(c.key) ?? 0),
        source: known.has(c.key) ? ('bsrs_city' as const) : (split.get(c.key) ?? ('none' as const)),
      }))
      .filter((g) => g.count > 0);
  }
}
