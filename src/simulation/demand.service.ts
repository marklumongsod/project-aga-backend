import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SimGroup } from './engine/utilization-engine';

/** Where a city's candidate count comes from: measured, or filled in by splitting a larger total evenly. */
export type DemandSource = 'bsrs_city' | 'split_province' | 'split_district' | 'none';

export interface DemandGroup extends SimGroup {
  regionPsgc: string;
  provincePsgc: string;
  /** provenance of `count` (for the data-quality report); not used by the simulation */
  source?: DemandSource;
}

interface CityRow {
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
 *   - NCR is reported per district (CAMANAVA, PASMAK ...): split evenly over the district's cities;
 *   - a province row minus its known cities is split evenly over the province's other cities.
 * Replace with T2MIS enrollee-candidate counts per city once they are loaded.
 */
@Injectable()
export class DemandService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

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
      const share = Math.max(s.completed - knownSum, 0) / rest.length;
      for (const k of rest) {
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
