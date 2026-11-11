import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SimGroup } from './engine/utilization-engine';
import { graduateDemand } from './demand-split';
import { qualificationKey } from './qualification-need';

export interface DemandGroup extends SimGroup {
  regionPsgc: string;
  provincePsgc: string;
  /** the part of `count` that is a share of province-only graduates (an estimate); the rest is placed in the town */
  estimated: number;
}

export interface CityRow {
  key: string;
  province_psgc: string;
  region_psgc: string;
  lat: number;
  lon: number;
  island_id: number;
}

/** One qualification's upcoming graduates, as the TESDA students list has them. */
export interface QualificationDemand {
  key: string;
  /** the name most graduates are listed under */
  name: string;
  towns: Map<string, number>;
  provinces: Map<string, number>;
}

export interface QualificationCatalog {
  cities: CityRow[];
  byKey: Map<string, QualificationDemand>;
}

/**
 * Candidates waiting for assessment, per city/municipality: the upcoming TESDA graduates (the TESDA API's students
 * list, every graduate finishing in the next 6 months, synced monthly into `upcoming_graduates`, counts only).
 *   - graduates the API places in a town count for that town;
 *   - graduates it places only in a province are split over the province's towns: 20% evenly, 80% by each town's own
 *     graduates (`graduateDemand`), and that share is marked as estimated.
 * The default view uses every qualification; a per-qualification view uses one.
 */
@Injectable()
export class DemandService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  private cities(): Promise<CityRow[]> {
    return this.db.query(`SELECT key, province_psgc, region_psgc, lat, lon, island_id FROM cities ORDER BY key`);
  }

  /** Upcoming graduates per qualification (matched by name, so "Driving II" and "DRIVING NC II" are one), counts only. */
  async qualificationCatalog(): Promise<QualificationCatalog> {
    const cities = await this.cities();
    const rows: Array<{ province_psgc: string; city_key: string | null; qualification: string; graduates: number }> = await this.db.query(
      `SELECT g.province_psgc, c.key AS city_key, g.qualification, sum(g.graduates)::int AS graduates
         FROM upcoming_graduates g LEFT JOIN cities c ON c.id = g.city_id
        GROUP BY 1, 2, 3`,
    );
    const byKey = new Map<string, QualificationDemand>();
    const nameCount = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const key = qualificationKey(r.qualification);
      if (!key) continue;
      let q = byKey.get(key);
      if (!q) byKey.set(key, (q = { key, name: r.qualification, towns: new Map(), provinces: new Map() }));
      if (r.city_key) q.towns.set(r.city_key, (q.towns.get(r.city_key) ?? 0) + r.graduates);
      else q.provinces.set(r.province_psgc, (q.provinces.get(r.province_psgc) ?? 0) + r.graduates);
      const names = nameCount.get(key) ?? new Map<string, number>();
      names.set(r.qualification, (names.get(r.qualification) ?? 0) + r.graduates);
      nameCount.set(key, names);
    }
    for (const [key, names] of nameCount) byKey.get(key)!.name = [...names].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
    return { cities, byKey };
  }

  /** One qualification's candidates per town. */
  qualificationGroups(cities: CityRow[], q: QualificationDemand): DemandGroup[] {
    return this.groups(cities, q.towns, q.provinces);
  }

  /** Candidates per town, every qualification: the default view and the daily stored run. */
  async currentGroups(): Promise<DemandGroup[]> {
    const cities = await this.cities();
    const rows: Array<{ province_psgc: string; city_key: string | null; graduates: number }> = await this.db.query(
      `SELECT g.province_psgc, c.key AS city_key, sum(g.graduates)::int AS graduates
         FROM upcoming_graduates g LEFT JOIN cities c ON c.id = g.city_id
        GROUP BY 1, 2`,
    );
    const towns = new Map<string, number>();
    const provinces = new Map<string, number>();
    for (const r of rows) {
      if (r.city_key) towns.set(r.city_key, (towns.get(r.city_key) ?? 0) + r.graduates);
      else provinces.set(r.province_psgc, (provinces.get(r.province_psgc) ?? 0) + r.graduates);
    }
    return this.groups(cities, towns, provinces);
  }

  private groups(cities: CityRow[], towns: Map<string, number>, provinces: Map<string, number>): DemandGroup[] {
    const byProvince = new Map<string, string[]>();
    for (const c of cities) byProvince.set(c.province_psgc, [...(byProvince.get(c.province_psgc) ?? []), c.key]);
    const demand = graduateDemand(byProvince, towns, provinces);
    return cities
      .filter((c) => demand.has(c.key))
      .map((c) => ({
        key: c.key,
        lat: c.lat,
        lon: c.lon,
        islandId: c.island_id,
        regionPsgc: c.region_psgc,
        provincePsgc: c.province_psgc,
        count: demand.get(c.key)!.count,
        estimated: demand.get(c.key)!.estimated,
      }));
  }
}
