import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { basename } from 'path';
import { ForecastPlace, ForecastRun, ForecastValue } from '../database/entities';
import { nowEpoch } from '../database/epoch';
import {
  ForecastLevel,
  PlaceMapRow,
  RawForecastRow,
  assertMappingShares,
  groupPlaceMappings,
  mappingKey,
  monthEpoch,
  parseForecastJson,
  parsePlacesCsv,
  validateForecastRows,
} from './forecast.util';

export interface ForecastImportOptions {
  /** forecasts_<month>.json */
  file: string;
  /** forecast_places.csv */
  places: string;
  /** optional forecast_meta_<month>.json (model version, sample rate, accuracy) */
  meta?: string;
  modelVersion?: string;
  sampleRate?: number;
  /** replace an existing run with the same forecast month + model version */
  replace?: boolean;
  /** validate and map, but do not write anything */
  dryRun?: boolean;
  /** write forecast_places (global mapping). The e2e tests set false. */
  persistPlaces?: boolean;
}

export interface ForecastImportReport {
  runId: string | null;
  forecastMonth: string;
  modelVersion: string;
  sampleRate: number;
  sourceRows: number;
  values: number;
  places: Record<ForecastLevel, number>;
  mappedSourceRows: Record<ForecastLevel, number>;
  excludedSourceRows: Record<ForecastLevel, number>;
  unmatchedCenters: number[];
  national: Array<{ targetMonth: string; horizon: number; candidates: number }>;
  persisted: boolean;
}

interface MetaFile {
  forecast_month?: string;
  generated_at?: string | number;
  model_version?: string;
  sample_rate?: number;
  trained_on?: string;
  test_accuracy?: Record<string, unknown>;
  [key: string]: unknown;
}

interface CenterInfo {
  id: number;
  name: string;
  provincePsgc: string | null;
  regionPsgc: string | null;
  visible: boolean;
}

/** Plain insert shape: excluding the relation property keeps TypeORM's deep-partial type happy. */
interface ForecastValueInsert {
  runId: string;
  level: string;
  sourcePlaceId: string;
  parentSourceId: string | null;
  targetType: string;
  targetCode: string;
  targetMonth: number;
  horizon: number;
  forecastSample: number;
  forecastReal: number;
  share: number;
  regionPsgc: string | null;
  provincePsgc: string | null;
  centerId: number | null;
}

const LEVELS: ForecastLevel[] = ['national', 'region', 'province', 'center'];

/**
 * Import the monthly model output. The Python job writes aggregates only; this service validates the file,
 * applies the raw-place -> PSGC/center mapping, and stores one row per mapped target.
 *
 * It never calls Python and never reads raw learner data.
 */
@Injectable()
export class ForecastImportService {
  private readonly log = new Logger(ForecastImportService.name);

  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async import(options: ForecastImportOptions): Promise<ForecastImportReport> {
    const forecastText = readFileSync(options.file, 'utf8');
    const placeText = readFileSync(options.places, 'utf8');
    const meta: MetaFile | null = options.meta
      ? (JSON.parse(readFileSync(options.meta, 'utf8')) as MetaFile)
      : null;

    const raw = parseForecastJson(forecastText);
    const mappingRows = parsePlacesCsv(placeText);
    const sampleRate = Number(options.sampleRate ?? meta?.sample_rate ?? 0.2);
    const validation = validateForecastRows(raw, sampleRate);
    if (meta?.forecast_month && meta.forecast_month !== validation.forecastMonth) {
      throw new Error(`Meta forecast_month ${meta.forecast_month} does not match the file ${validation.forecastMonth}`);
    }

    const modelVersion =
      options.modelVersion ??
      meta?.model_version ??
      `forecast-${createHash('sha256').update(forecastText).digest('hex').slice(0, 12)}`;
    const generatedAt = this.epochOf(
      meta?.generated_at,
      Math.floor(statSync(options.file).mtimeMs / 1000),
    );

    const mapping = groupPlaceMappings(mappingRows);
    assertMappingShares(mapping);

    const regions = new Map<string, string>(
      (await this.db.query(`SELECT psgc, name FROM regions`)).map((r: { psgc: string; name: string }) => [r.psgc, r.name]),
    );
    const provinces = new Map<string, { name: string; regionPsgc: string }>(
      (await this.db.query(`SELECT psgc, name, region_psgc FROM provinces`)).map(
        (p: { psgc: string; name: string; region_psgc: string }) => [
          p.psgc,
          { name: p.name, regionPsgc: p.region_psgc },
        ],
      ),
    );
    const centers = new Map<number, CenterInfo>(
      (
        await this.db.query(
          `SELECT id, name, province_psgc, region_psgc, is_foreign, is_closed, is_hidden
             FROM assessment_centers`,
        )
      ).map((c: Record<string, unknown>) => [
        Number(c.id),
        {
          id: Number(c.id),
          name: String(c.name),
          provincePsgc: (c.province_psgc as string | null) ?? null,
          regionPsgc: (c.region_psgc as string | null) ?? null,
          visible: !c.is_foreign && !c.is_closed && !c.is_hidden,
        },
      ]),
    );

    this.validateMapping(mapping, regions, provinces);

    const values: Array<Omit<ForecastValueInsert, 'runId'>> = [];
    const mappedSourceRows: Record<ForecastLevel, number> = {
      national: 0,
      region: 0,
      province: 0,
      center: 0,
    };
    const excludedSourceRows: Record<ForecastLevel, number> = {
      national: 0,
      region: 0,
      province: 0,
      center: 0,
    };
    const unmatchedCenters = new Set<number>();

    for (const row of raw) {
      const level = row.level;
      // Center IDs are direct. Use the current backend status, not the CSV's snapshot, so a center that
      // closes or becomes visible between mapping runs is handled without regenerating the map.
      if (level === 'center') {
        const center = centers.get(Number(row.place_id));
        if (!center?.visible) {
          if (!center) unmatchedCenters.add(Number(row.place_id));
          excludedSourceRows.center += 1;
          continue;
        }
        values.push({
          level,
          sourcePlaceId: String(row.place_id),
          parentSourceId: row.parent_id ?? null,
          targetType: 'center',
          targetCode: String(center.id),
          targetMonth: monthEpoch(row.target_month),
          horizon: Number(row.horizon),
          forecastSample: Number(row.forecast_sample),
          forecastReal: Number(row.forecast_real),
          share: 1,
          regionPsgc: center.regionPsgc,
          provincePsgc: center.provincePsgc,
          centerId: center.id,
        });
        mappedSourceRows.center += 1;
        continue;
      }

      const key = mappingKey(level, row.place_id);
      const targets = mapping.get(key) ?? [];
      if (targets.length === 0) throw new Error(`No forecast mapping for ${key}`);
      const active = targets.filter((t) => t.targetType !== 'excluded');
      if (active.length === 0) {
        excludedSourceRows[level] += 1;
        continue;
      }

      for (const target of active) {
        const area = this.areaFor(target, provinces);
        values.push({
          level,
          sourcePlaceId: String(row.place_id),
          parentSourceId: row.parent_id ?? null,
          targetType: target.targetType,
          targetCode: target.targetCode,
          targetMonth: monthEpoch(row.target_month),
          horizon: Number(row.horizon),
          forecastSample: Number(row.forecast_sample),
          forecastReal: Number(row.forecast_real),
          share: target.share,
          regionPsgc: area.regionPsgc,
          provincePsgc: area.provincePsgc,
          centerId: area.centerId,
        });
      }
      mappedSourceRows[level] += 1;
    }

    const national = raw
      .filter((r) => r.level === 'national')
      .map((r) => ({
        targetMonth: r.target_month,
        horizon: Number(r.horizon),
        candidates: Math.round(Number(r.forecast_real)),
      }))
      .sort((a, b) => a.targetMonth.localeCompare(b.targetMonth) || a.horizon - b.horizon);

    const report: ForecastImportReport = {
      runId: null,
      forecastMonth: validation.forecastMonth,
      modelVersion,
      sampleRate,
      sourceRows: raw.length,
      values: values.length,
      places: {
        national: validation.places.get('national')?.size ?? 0,
        region: validation.places.get('region')?.size ?? 0,
        province: validation.places.get('province')?.size ?? 0,
        center: validation.places.get('center')?.size ?? 0,
      },
      mappedSourceRows,
      excludedSourceRows,
      unmatchedCenters: [...unmatchedCenters].sort((a, b) => a - b),
      national,
      persisted: false,
    };

    if (options.dryRun) return report;

    const forecastMonthEpoch = monthEpoch(validation.forecastMonth);
    const persistPlaces = options.persistPlaces !== false;
    const run = await this.db.transaction(async (manager) => {
      if (options.replace) {
        await manager.query(`DELETE FROM forecast_runs WHERE forecast_month = $1 AND model_version = $2`, [
          forecastMonthEpoch,
          modelVersion,
        ]);
      } else {
        const existing = await manager.getRepository(ForecastRun).findOne({
          where: { forecastMonth: forecastMonthEpoch, modelVersion },
        });
        if (existing) {
          throw new Error(`Forecast ${validation.forecastMonth} / ${modelVersion} already exists; use --replace`);
        }
      }

      if (persistPlaces) {
        await manager.query(`DELETE FROM forecast_places`);
        for (let i = 0; i < mappingRows.length; i += 1000) {
          await manager.insert(ForecastPlace, mappingRows.slice(i, i + 1000));
        }
      }

      const runRepo = manager.getRepository(ForecastRun);
      const saved = await runRepo.save(
        runRepo.create({
          forecastMonth: forecastMonthEpoch,
          generatedAt,
          importedAt: nowEpoch(),
          modelVersion,
          sampleRate,
          rowCount: raw.length,
          sourceFile: basename(options.file),
          metadata: meta ?? {},
        }),
      );

      const rows: ForecastValueInsert[] = values.map((value) => ({ ...value, runId: saved.id }));
      for (let i = 0; i < rows.length; i += 1000) {
        await manager.insert(ForecastValue, rows.slice(i, i + 1000));
      }
      return saved;
    });

    report.runId = run.id;
    report.persisted = true;
    this.log.log(
      `forecast ${validation.forecastMonth} imported: ${report.sourceRows} source rows, ` +
        `${report.values} mapped values, ${report.places.region} regions / ${report.places.province} provinces / ` +
        `${report.places.center} centers`,
    );
    return report;
  }

  /** Reject a region/province mapping whose target is not a real PSGC before touching the database. */
  private validateMapping(
    mapping: Map<string, PlaceMapRow[]>,
    regions: Map<string, string>,
    provinces: Map<string, { name: string; regionPsgc: string }>,
  ): void {
    for (const [key, rows] of mapping) {
      const level = rows[0]?.level;
      if (!level) continue;
      for (const row of rows) {
        if (row.targetType === 'excluded') continue;
        if (level === 'national') {
          if (row.targetType !== 'national' || row.targetCode !== 'PH') {
            throw new Error(`National mapping ${key} must target PH`);
          }
          continue;
        }
        if (level === 'region') {
          if (row.targetType !== 'region' || !regions.has(row.targetCode)) {
            throw new Error(`Region mapping ${key} targets unknown region ${row.targetCode}`);
          }
          continue;
        }
        if (level === 'province') {
          if (row.targetType !== 'province' || !provinces.has(row.targetCode)) {
            throw new Error(`Province mapping ${key} targets unknown province ${row.targetCode}`);
          }
          continue;
        }
      }
    }
  }

  private areaFor(
    target: PlaceMapRow,
    provinces: Map<string, { name: string; regionPsgc: string }>,
  ): { regionPsgc: string | null; provincePsgc: string | null; centerId: number | null } {
    if (target.targetType === 'national') {
      return { regionPsgc: null, provincePsgc: null, centerId: null };
    }
    if (target.targetType === 'region') {
      return { regionPsgc: target.targetCode, provincePsgc: null, centerId: null };
    }
    if (target.targetType === 'province') {
      const province = provinces.get(target.targetCode);
      if (!province) throw new Error(`Unknown province ${target.targetCode}`);
      return { regionPsgc: province.regionPsgc, provincePsgc: target.targetCode, centerId: null };
    }
    throw new Error(`Unexpected target type ${target.targetType} for ${target.level} ${target.sourcePlaceId}`);
  }

  private epochOf(value: unknown, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
    if (typeof value === 'string') {
      const ms = Date.parse(value);
      if (Number.isFinite(ms)) return Math.floor(ms / 1000);
    }
    return fallback;
  }
}
