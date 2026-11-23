import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { AreaLevel, ForecastRun, Role } from '../database/entities';
import { AreaScopeService } from '../scope/area-scope.service';
import {
  ForecastAccuracyDto,
  ForecastAreaDto,
  ForecastLevelDto,
  ForecastMetaDto,
  ForecastPointDto,
  ForecastQueryDto,
  ForecastResponseDto,
  ForecastRunDto,
} from './forecast.dto';
import { monthLabel, previousMonthStart } from './forecast.util';

interface SeriesRow {
  target_month: string;
  horizon: number;
  candidates: string | number;
}

interface ChildRow extends SeriesRow {
  code: string;
  name: string;
}

type AreaForecastLevel = ForecastLevelDto.NATIONAL | ForecastLevelDto.REGION | ForecastLevelDto.PROVINCE;

/**
 * Serves the latest imported forecast. The values are already mapped to PSGC/center by the importer; this service
 * only applies role scoping and sums `forecast_real * share` for split places.
 */
@Injectable()
export class ForecastService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly scope: AreaScopeService,
  ) {}

  async meta(): Promise<ForecastMetaDto> {
    const run = await this.latestRun();
    if (!run) return { latest: null, trainedOn: null, accuracy: null };
    return {
      latest: this.runDto(run),
      trainedOn: typeof run.metadata?.trained_on === 'string' ? run.metadata.trained_on : null,
      accuracy: this.accuracyMap(run.metadata),
    };
  }

  async get(user: AuthUser, q: ForecastQueryDto): Promise<ForecastResponseDto> {
    const run = await this.latestRun();
    if (!run) throw new NotFoundException('No forecast has been imported yet - run npm run forecast:import');

    if (!q.level) {
      const home = await this.scope.home(user);
      const level =
        home.level === AreaLevel.REGION
          ? ForecastLevelDto.REGION
          : home.level === AreaLevel.PROVINCE
            ? ForecastLevelDto.PROVINCE
            : ForecastLevelDto.NATIONAL;
      return this.forArea(run, level, home.code, home.name);
    }

    if (q.level === ForecastLevelDto.NATIONAL) {
      const area = await this.scope.resolve(user, AreaLevel.NATIONAL);
      return this.forArea(run, ForecastLevelDto.NATIONAL, area.code, area.name);
    }

    if (q.level === ForecastLevelDto.REGION || q.level === ForecastLevelDto.PROVINCE) {
      if (!q.code) throw new BadRequestException('code is required for this level');
      const area = await this.scope.resolve(
        user,
        q.level === ForecastLevelDto.REGION ? AreaLevel.REGION : AreaLevel.PROVINCE,
        q.code,
      );
      return this.forArea(run, q.level, area.code, area.name);
    }

    if (q.level === ForecastLevelDto.CENTER) {
      if (!q.code) throw new BadRequestException('code is required for this level');
      const id = Number(q.code);
      if (!Number.isInteger(id) || id <= 0) throw new BadRequestException('code must be a center id');
      return this.forCenter(user, run, id);
    }

    throw new BadRequestException('Unknown forecast level');
  }

  private async latestRun(): Promise<ForecastRun | null> {
    const [run] = await this.db.getRepository(ForecastRun).find({
      order: { forecastMonth: 'DESC', importedAt: 'DESC' },
      take: 1,
    });
    return run ?? null;
  }

  private runDto(run: ForecastRun): ForecastRunDto {
    return {
      id: run.id,
      forecastMonth: monthLabel(run.forecastMonth),
      generatedAt: run.generatedAt,
      importedAt: run.importedAt,
      modelVersion: run.modelVersion,
      sampleRate: run.sampleRate,
      stale: run.forecastMonth < previousMonthStart(),
    };
  }

  private async forArea(
    run: ForecastRun,
    level: AreaForecastLevel,
    code: string,
    name: string,
  ): Promise<ForecastResponseDto> {
    const forecast = await this.series(run.id, level, code);
    const children =
      level === ForecastLevelDto.NATIONAL
        ? await this.childrenRegions(run.id)
        : level === ForecastLevelDto.REGION
          ? await this.childrenProvinces(run.id, code)
          : await this.childrenCenters(run.id, code);
    return {
      run: this.runDto(run),
      accuracy: this.levelAccuracy(run.metadata, level.toLowerCase()),
      area: {
        level,
        code,
        name,
        available: forecast.length > 0,
        forecast,
      },
      children,
      coverage: await this.coverage(run.id, level, code, children.length),
    };
  }

  private async forCenter(user: AuthUser, run: ForecastRun, id: number): Promise<ForecastResponseDto> {
    const [center] = await this.db.query(
      `SELECT id, name, province_psgc, region_psgc, is_foreign, is_closed, is_hidden
         FROM assessment_centers WHERE id = $1`,
      [id],
    );
    if (!center) throw new NotFoundException(`Assessment center ${id} not found`);
    if (user.role !== Role.CO) {
      if (!center.province_psgc) throw new ForbiddenException('This center is outside your office scope');
      await this.scope.assertAllowed(user, { level: AreaLevel.PROVINCE, code: center.province_psgc, name: '' });
    }

    const visible = !center.is_foreign && !center.is_closed && !center.is_hidden;
    const forecast = visible ? await this.seriesCenter(run.id, id) : [];
    const note = center.is_foreign
      ? 'Foreign center: not part of the Philippine forecast view'
      : center.is_closed
        ? 'Closed center: no current forecast'
        : center.is_hidden
          ? 'Hidden center: no current forecast'
          : forecast.length
            ? null
            : 'No recent assessment history for this center';

    return {
      run: this.runDto(run),
      accuracy: this.levelAccuracy(run.metadata, 'center'),
      area: {
        level: ForecastLevelDto.CENTER,
        code: String(center.id),
        name: center.name,
        available: forecast.length > 0,
        forecast,
        note,
      },
      children: [],
      coverage: null,
    };
  }

  private async series(runId: string, level: AreaForecastLevel, code: string): Promise<ForecastPointDto[]> {
    const where =
      level === ForecastLevelDto.NATIONAL
        ? `level = 'region' AND region_psgc IS NOT NULL`
        : level === ForecastLevelDto.REGION
          ? `level = 'region' AND region_psgc = $2`
          : `level = 'province' AND province_psgc = $2`;
    const params = level === ForecastLevelDto.NATIONAL ? [runId] : [runId, code];
    const rows: SeriesRow[] = await this.db.query(
      `SELECT target_month, horizon, round(sum(forecast_real * share))::int AS candidates
         FROM forecast_values
        WHERE run_id = $1 AND ${where}
        GROUP BY target_month, horizon
        ORDER BY target_month, horizon`,
      params,
    );
    return this.points(rows);
  }

  private async seriesCenter(runId: string, centerId: number): Promise<ForecastPointDto[]> {
    const rows: SeriesRow[] = await this.db.query(
      `SELECT target_month, horizon, round(sum(forecast_real * share))::int AS candidates
         FROM forecast_values
        WHERE run_id = $1 AND level = 'center' AND center_id = $2
        GROUP BY target_month, horizon
        ORDER BY target_month, horizon`,
      [runId, centerId],
    );
    return this.points(rows);
  }

  private async childrenRegions(runId: string): Promise<ForecastAreaDto[]> {
    const rows: ChildRow[] = await this.db.query(
      `SELECT f.region_psgc AS code, r.name, f.target_month, f.horizon,
              round(sum(f.forecast_real * f.share))::int AS candidates
         FROM forecast_values f
         JOIN regions r ON r.psgc = f.region_psgc
        WHERE f.run_id = $1 AND f.level = 'region'
        GROUP BY f.region_psgc, r.name, f.target_month, f.horizon
        ORDER BY r.name, f.target_month, f.horizon`,
      [runId],
    );
    return this.groupChildren(rows, ForecastLevelDto.REGION);
  }

  private async childrenProvinces(runId: string, regionPsgc: string): Promise<ForecastAreaDto[]> {
    const rows: ChildRow[] = await this.db.query(
      `SELECT f.province_psgc AS code, p.name, f.target_month, f.horizon,
              round(sum(f.forecast_real * f.share))::int AS candidates
         FROM forecast_values f
         JOIN provinces p ON p.psgc = f.province_psgc
        WHERE f.run_id = $1 AND f.level = 'province' AND f.region_psgc = $2
        GROUP BY f.province_psgc, p.name, f.target_month, f.horizon
        ORDER BY p.name, f.target_month, f.horizon`,
      [runId, regionPsgc],
    );
    return this.groupChildren(rows, ForecastLevelDto.PROVINCE);
  }

  private async childrenCenters(runId: string, provincePsgc: string): Promise<ForecastAreaDto[]> {
    const rows: ChildRow[] = await this.db.query(
      `SELECT f.center_id::text AS code, c.name, f.target_month, f.horizon,
              round(sum(f.forecast_real * f.share))::int AS candidates
         FROM forecast_values f
         JOIN assessment_centers c ON c.id = f.center_id
        WHERE f.run_id = $1 AND f.level = 'center' AND f.province_psgc = $2
          AND NOT c.is_foreign AND NOT c.is_closed AND NOT c.is_hidden
        GROUP BY f.center_id, c.name, f.target_month, f.horizon
        ORDER BY c.name, f.target_month, f.horizon`,
      [runId, provincePsgc],
    );
    return this.groupChildren(rows, ForecastLevelDto.CENTER);
  }

  private groupChildren(rows: ChildRow[], level: ForecastLevelDto): ForecastAreaDto[] {
    const map = new Map<string, ForecastAreaDto>();
    for (const row of rows) {
      const code = String(row.code);
      let area = map.get(code);
      if (!area) {
        area = { level, code, name: row.name, available: true, forecast: [] };
        map.set(code, area);
      }
      area.forecast.push({
        targetMonth: monthLabel(Number(row.target_month)),
        horizon: Number(row.horizon),
        candidates: Number(row.candidates),
      });
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private points(rows: SeriesRow[]): ForecastPointDto[] {
    return rows.map((row) => ({
      targetMonth: monthLabel(Number(row.target_month)),
      horizon: Number(row.horizon),
      candidates: Number(row.candidates),
    }));
  }

  private async coverage(
    runId: string,
    level: AreaForecastLevel,
    code: string,
    withForecast: number,
  ): Promise<{ total: number; withForecast: number } | null> {
    if (level === ForecastLevelDto.NATIONAL) {
      const [row] = await this.db.query(`SELECT count(*)::int AS n FROM regions`);
      return { total: Number(row.n), withForecast };
    }
    if (level === ForecastLevelDto.REGION) {
      const [row] = await this.db.query(`SELECT count(*)::int AS n FROM provinces WHERE region_psgc = $1`, [code]);
      return { total: Number(row.n), withForecast };
    }
    if (level === ForecastLevelDto.PROVINCE) {
      const [row] = await this.db.query(
        `SELECT count(*)::int AS n FROM assessment_centers
          WHERE province_psgc = $1 AND NOT is_foreign AND NOT is_closed AND NOT is_hidden`,
        [code],
      );
      return { total: Number(row.n), withForecast };
    }
    return null;
  }

  private levelAccuracy(metadata: Record<string, unknown> | null, level: string): ForecastAccuracyDto | null {
    return this.accuracyMap(metadata)?.[level] ?? null;
  }

  private accuracyMap(metadata: Record<string, unknown> | null): Record<string, ForecastAccuracyDto> | null {
    const raw = metadata?.test_accuracy;
    if (!raw || typeof raw !== 'object') return null;
    const out: Record<string, ForecastAccuracyDto> = {};
    for (const level of ['national', 'region', 'province', 'center']) {
      const value = (raw as Record<string, unknown>)[level];
      if (value && typeof value === 'object') {
        const r = value as Record<string, unknown>;
        const num = (key: string) => {
          const n = r[key];
          return typeof n === 'number' && Number.isFinite(n) ? n : null;
        };
        out[level] = {
          wape1Month: num('WAPE_1_month'),
          wape1To6: num('WAPE_1_6'),
          wape6Months: num('WAPE_6_months'),
          bias: num('bias'),
        };
      }
    }
    return Object.keys(out).length ? out : null;
  }
}
