import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { densityBand, densityBreaks, densityLegend } from '../common/density';
import { DESERT_LEVELS, toEpoch } from '../common/rate-band';
import { AreaLevel } from '../database/entities';
import { AreaRef, AreaScopeService } from '../scope/area-scope.service';
import { SimulationService } from '../simulation/simulation.service';
import { AreaStatsDto, DashboardQueryDto, DesertSummaryDto, OverviewDto } from './dashboard.dto';

interface AreaRow {
  level: AreaLevel;
  area_key: string;
  parent_key: string | null;
  name: string;
  candidates: number;
  flagged: number;
  served: number;
  centers: number;
  flagged_share: number;
  service_rate: number | null;
  desert_level: number;
  desert_cities: number;
  desert_candidates: number;
  estimated_candidates: number;
  nearest_minutes: number | null;
}

const NAME_SQL = `COALESCE(r.name, p.name, c.name, CASE WHEN a.area_key = 'PH' THEN 'Philippines' END, a.area_key)`;
const JOINS = `LEFT JOIN regions r ON a.level = 'REGION' AND r.psgc = a.area_key
               LEFT JOIN provinces p ON a.level = 'PROVINCE' AND p.psgc = a.area_key
               LEFT JOIN cities c ON a.level = 'CITY' AND c.key = a.area_key`;

/**
 * Worst first:
 *   0. assessment deserts (team doc: a city with candidates and no center within the travel range), most candidates first
 *   1. areas without a center of their own where candidates are flagged, by flagged
 *   2. areas with centers, by flagged share
 *   3. areas without a center and nobody flagged
 */
function tier(x: AreaStatsDto) {
  if (x.level === AreaLevel.CITY && x.desertLevel > 0) return 0;
  if (x.centers === 0) return x.flagged > 0 ? 1 : 3;
  return 2;
}

function worstFirst(a: AreaStatsDto, b: AreaStatsDto) {
  const t = tier(a) - tier(b);
  if (t) return t;
  return (
    (tier(a) === 0 ? b.candidates - a.candidates : tier(a) === 1 ? b.flagged - a.flagged : b.flaggedShare - a.flaggedShare) ||
    b.flagged - a.flagged ||
    a.name.localeCompare(b.name)
  );
}

@Injectable()
export class DashboardService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly scope: AreaScopeService,
    private readonly sim: SimulationService,
  ) {}

  childLevel(level: AreaLevel): AreaLevel {
    // The Philippines lists its regions, a region its provinces, a province its cities and municipalities.
    return level === AreaLevel.NATIONAL ? AreaLevel.REGION : level === AreaLevel.REGION ? AreaLevel.PROVINCE : AreaLevel.CITY;
  }

  private toDto(r: AreaRow): AreaStatsDto {
    return {
      level: r.level,
      code: r.area_key,
      name: r.name,
      parentCode: r.parent_key ?? null,
      candidates: r.candidates,
      flagged: r.flagged,
      served: r.served,
      flaggedShare: r.flagged_share,
      serviceRate: r.service_rate,
      centers: r.centers,
      densityBand: 0, // set against the siblings in childRows
      desertLevel: r.desert_level ?? 0,
      desertCities: r.desert_cities ?? 0,
      desertCandidates: r.desert_candidates ?? 0,
      estimatedCandidates: r.estimated_candidates ?? 0,
      nearestMinutes: r.nearest_minutes,
    };
  }

  /** Density classes (quintiles) of the areas being compared, and where each falls. Hotspot = the densest fifth. */
  private withDensity(rows: AreaStatsDto[]) {
    const breaks = densityBreaks(rows.map((r) => r.candidates));
    const max = rows.reduce((m, r) => Math.max(m, r.candidates), 0);
    return {
      rows: rows.map((r) => ({ ...r, densityBand: densityBand(r.candidates, breaks) })),
      legend: densityLegend(breaks, max),
    };
  }

  /** Assessment deserts inside an area, by level (team doc). */
  async desertSummary(runId: string, area: AreaRef): Promise<DesertSummaryDto> {
    const params: unknown[] = [runId];
    let join = '';
    let filter = '';
    if (area.level === AreaLevel.REGION) {
      join = 'JOIN provinces p ON p.psgc = a.parent_key';
      filter = 'AND p.region_psgc = $2';
      params.push(area.code);
    } else if (area.level === AreaLevel.PROVINCE) {
      filter = 'AND a.parent_key = $2';
      params.push(area.code);
    }
    const rows: Array<{ level: number; cities: number; candidates: number }> = await this.db.query(
      `SELECT a.desert_level AS level, count(*)::int AS cities, COALESCE(sum(a.candidates), 0)::int AS candidates
         FROM area_utilization a ${join}
        WHERE a.run_id = $1 AND a.level = 'CITY' AND a.desert_level > 0 ${filter}
        GROUP BY 1`,
      params,
    );
    const byLevel = DESERT_LEVELS.filter((l) => l.band > 0).map((l) => {
      const r = rows.find((x) => x.level === l.band);
      return { level: l.band, label: l.label, cities: r?.cities ?? 0, candidates: r?.candidates ?? 0 };
    });
    return {
      cities: byLevel.reduce((n, l) => n + l.cities, 0),
      candidates: byLevel.reduce((n, l) => n + l.candidates, 0),
      byLevel,
    };
  }

  /** Area rows of a run for the children of `area` (regions of PH, provinces of a region, cities of a province). */
  async childRows(runId: string, area: AreaRef): Promise<AreaStatsDto[]> {
    const child = this.childLevel(area.level);
    const params: unknown[] = [runId, child];
    let filter = '';
    if (area.level === AreaLevel.REGION) {
      params.push(area.code);
      filter = 'AND a.parent_key = $3';
    } else if (area.level === AreaLevel.PROVINCE) {
      params.push(area.code);
      filter = 'AND a.parent_key = $3';
    }
    const rows: AreaRow[] = await this.db.query(
      `SELECT a.level, a.area_key, a.parent_key, ${NAME_SQL} AS name, a.candidates, a.flagged, a.served, a.centers,
              a.flagged_share, a.service_rate, a.desert_level, a.desert_cities, a.desert_candidates, a.estimated_candidates,
              a.nearest_minutes
         FROM area_utilization a ${JOINS}
        WHERE a.run_id = $1 AND a.level = $2 ${filter}`,
      params,
    );
    const sorted = rows
      .map((r) => this.toDto(r))
      .sort(worstFirst)
      .map((r, i) => ({ ...r, rank: i + 1 }));
    return this.withDensity(sorted).rows;
  }

  async overview(user: AuthUser, q: DashboardQueryDto): Promise<OverviewDto> {
    const area = await this.scope.resolve(user, q.level, q.code);
    const run = await this.sim.runFor(q.limitMinutes);
    const [self]: AreaRow[] = await this.db.query(
      `SELECT a.level, a.area_key, a.parent_key, ${NAME_SQL} AS name, a.candidates, a.flagged, a.served, a.centers,
              a.flagged_share, a.service_rate, a.desert_level, a.desert_cities, a.desert_candidates, a.estimated_candidates,
              a.nearest_minutes
         FROM area_utilization a ${JOINS} WHERE a.run_id = $1 AND a.level = $2 AND a.area_key = $3`,
      [run.id, area.level, area.code],
    );
    const stats: AreaStatsDto = self
      ? { ...this.toDto(self), name: area.name }
      : {
          level: area.level,
          code: area.code,
          name: area.name,
          parentCode: null,
          candidates: 0,
          flagged: 0,
          served: 0,
          flaggedShare: 0,
          serviceRate: null,
          centers: 0,
          densityBand: 0,
          desertLevel: 0,
          desertCities: 0,
          desertCandidates: 0,
          estimatedCandidates: 0,
          nearestMinutes: null,
        };

    const rows = await this.childRows(run.id, area);
    return {
      run: { id: run.id, finishedAt: toEpoch(run.finishedAt), assumptions: run.summary?.assumptions ?? {} },
      area: stats,
      childLevel: this.childLevel(area.level),
      // only areas with flagged candidates need attention; an area with none is never listed
      top: rows.filter((r) => r.flagged > 0).slice(0, area.level === AreaLevel.NATIONAL ? 5 : 3),
      rows,
      deserts: await this.desertSummary(run.id, area),
      desertLegend: DESERT_LEVELS,
      densityLegend: this.withDensity(rows).legend,
    };
  }

  /** Choropleth for the map: the children of the area as GeoJSON with candidates, flagged share, desert level and density class. */
  async map(user: AuthUser, q: DashboardQueryDto) {
    const area = await this.scope.resolve(user, q.level, q.code);
    const run = await this.sim.runFor(q.limitMinutes);
    const rows = new Map((await this.childRows(run.id, area)).map((r) => [r.code, r]));
    const child = this.childLevel(area.level);
    const tol = area.level === AreaLevel.NATIONAL ? 0.004 : area.level === AreaLevel.REGION ? 0.002 : 0.0007;
    const geo: Array<{ code: string; name: string; geometry: string }> =
      child === AreaLevel.REGION
        ? await this.db.query(
            `SELECT psgc AS code, name, ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, $1), 5) AS geometry FROM regions WHERE geom IS NOT NULL`,
            [tol],
          )
        : child === AreaLevel.PROVINCE
        ? await this.db.query(
            `SELECT psgc AS code, name, ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, $1), 5) AS geometry
               FROM provinces WHERE region_psgc = $2`,
            [tol, area.code],
          )
        : await this.db.query(
            `SELECT key AS code, name, ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, $1), 5) AS geometry
               FROM cities WHERE province_psgc = $2`,
            [tol, area.code],
          );
    return {
      type: 'FeatureCollection' as const,
      properties: {
        area,
        childLevel: child,
        runId: run.id,
        desertLegend: DESERT_LEVELS,
        densityLegend: this.withDensity([...rows.values()]).legend,
      },
      features: geo.map((g) => {
        const s = rows.get(g.code);
        return {
          type: 'Feature' as const,
          id: g.code,
          geometry: JSON.parse(g.geometry),
          properties: s ?? {
            code: g.code,
            name: g.name,
            parentCode: null,
            candidates: 0,
            flagged: 0,
            served: 0,
            flaggedShare: 0,
            serviceRate: null,
            centers: 0,
            densityBand: -1,
            desertLevel: 0,
            desertCities: 0,
            desertCandidates: 0,
            estimatedCandidates: 0,
            nearestMinutes: null,
          },
        };
      }),
    };
  }

  /** Assessment centers in the area with predicted candidates (hover card). */
  async centers(user: AuthUser, q: DashboardQueryDto) {
    const area = await this.scope.resolve(user, q.level, q.code);
    const run = await this.sim.runFor(q.limitMinutes);
    const filter =
      area.level === AreaLevel.NATIONAL
        ? ''
        : area.level === AreaLevel.REGION
          ? 'AND c.region_psgc = $2'
          : 'AND c.province_psgc = $2';
    const rows = await this.db.query(
      `SELECT c.id, c.name, c.lat, c.lon, ci.name AS city, u.demand, u.reach, u.service_rate
         FROM center_utilization u
         JOIN assessment_centers c ON c.id = u.center_id
         LEFT JOIN cities ci ON ci.id = c.city_id
        WHERE u.run_id = $1 ${filter}
        ORDER BY u.demand DESC`,
      area.level === AreaLevel.NATIONAL ? [run.id] : [run.id, area.code],
    );
    return rows.map((r: Record<string, number | string | null>) => ({
      id: r.id,
      name: r.name,
      city: r.city,
      lat: r.lat,
      lon: r.lon,
      /** TESDA only: candidates who would go to this center first */
      predictedCandidates: r.demand,
      /** candidates in every city this center can reach (overlaps across centers) */
      reach: r.reach,
      /** reach-based access: predictedCandidates / reach; null when reach is 0 or unknown */
      serviceRate: r.service_rate,
    }));
  }
}
