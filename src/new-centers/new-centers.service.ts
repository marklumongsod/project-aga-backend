import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { manilaMonthStart } from '../common/quarter';
import { AreaLevel, NewCenterPrediction } from '../database/entities';
import { nowEpoch } from '../database/epoch';
import { AreaScopeService } from '../scope/area-scope.service';
import { NewCenterMappingService } from './new-center-mapping.service';
import {
  NewCenterMetaDto,
  NewCenterMonthlyDto,
  NewCenterPredictDto,
  NewCenterPredictionDto,
} from './new-centers.dto';

interface ModelMonthly {
  month_since_accreditation: number;
  target_month: string;
  expected_sample: number;
  expected_real: number;
}

interface ModelPrediction {
  name: string;
  accreditation_month: string;
  chance_any_candidates: number;
  first_year_expected_sample: number;
  first_year_expected_real: number;
  monthly: ModelMonthly[];
}

interface ModelMeta {
  lastMonth: string;
  latestAccreditationMonth: string;
  modelVersion: string;
  sampleRate: number;
  trainedOn: string | null;
  testAccuracy: Record<string, unknown> | null;
  versions: Record<string, unknown> | null;
  loadSeconds: number;
}

interface ModelPredictResponse {
  lastMonth: string;
  modelVersion: string;
  predictions: ModelPrediction[];
}

function monthEpoch(label: string): number {
  const match = /^(\d{4})-(\d{2})$/.exec(label);
  if (!match) throw new BadRequestException('Month must look like 2026-11');
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new BadRequestException('Month must look like 2026-11');
  return manilaMonthStart(year, month);
}

/**
 * Calls the internal New Center Model service. The raw data and Python process stay outside NestJS.
 *
 * The user gives backend PSGC/qualification keys; this service maps them to the raw T2MIS IDs the model expects,
 * validates the pin/role/month, stores the prediction for audit/comparison, and returns a camelCase response.
 */
@Injectable()
export class NewCentersService {
  private readonly log = new Logger(NewCentersService.name);
  private metaCache: { at: number; value: ModelMeta } | null = null;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly scope: AreaScopeService,
    private readonly mapping: NewCenterMappingService,
    private readonly config: ConfigService,
  ) {}

  async meta(): Promise<NewCenterMetaDto> {
    const meta = await this.modelMeta();
    return {
      lastMonth: meta.lastMonth,
      latestAccreditationMonth: meta.latestAccreditationMonth,
      modelVersion: meta.modelVersion,
      sampleRate: meta.sampleRate,
      trainedOn: meta.trainedOn,
      testAccuracy: meta.testAccuracy,
      versions: meta.versions,
      loadSeconds: meta.loadSeconds,
    };
  }

  async predict(user: AuthUser, dto: NewCenterPredictDto): Promise<NewCenterPredictionDto> {
    if (!this.mapping.available) {
      throw new ServiceUnavailableException('New Center Model mapping is not configured');
    }

    const [province] = await this.db.query(`SELECT psgc, name FROM provinces WHERE psgc = $1`, [
      dto.provincePsgc,
    ]);
    if (!province) throw new NotFoundException(`Province ${dto.provincePsgc} not found`);
    const area = { level: AreaLevel.PROVINCE, code: String(province.psgc), name: String(province.name) };
    await this.scope.assertAllowed(user, area);
    if (!(await this.scope.pointInArea(area, dto.lat, dto.lon))) {
      throw new BadRequestException('The pin is outside the selected province');
    }

    const provinceMap = this.mapping.province(dto.provincePsgc);
    if (!provinceMap) {
      throw new BadRequestException(`Province ${dto.provincePsgc} is not mapped to a raw T2MIS province`);
    }

    const qualifications = dto.qualificationKeys.map((key) => this.mapping.qualification(key));
    const unknown = dto.qualificationKeys.filter((_, i) => !qualifications[i]);
    if (unknown.length) {
      throw new BadRequestException(`Unknown or unsupported qualification(s): ${unknown.join(', ')}`);
    }
    const rawQualIds = [...new Set(qualifications.map((q) => q!.rawQualId))];

    const meta = await this.modelMeta();
    monthEpoch(dto.accreditationMonth);
    if (dto.accreditationMonth > meta.latestAccreditationMonth) {
      throw new BadRequestException(
        `accreditationMonth ${dto.accreditationMonth} is after the latest allowed ${meta.latestAccreditationMonth}`,
      );
    }

    const center = {
      name: dto.name?.trim() || 'Planned center',
      province_id: provinceMap.rawProvinceId,
      qual_ids: rawQualIds,
      accreditation_month: dto.accreditationMonth,
      center_type: dto.centerType,
      center_class: dto.centerClass,
      latitude: dto.lat,
      longitude: dto.lon,
    };

    const response = await this.request<ModelPredictResponse>('/predict', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ centers: [center] }),
    });
    const prediction = response.predictions?.[0];
    if (!prediction) throw new ServiceUnavailableException('New Center Model returned no prediction');

    const monthly: NewCenterMonthlyDto[] = prediction.monthly.map((row) => ({
      month: row.month_since_accreditation,
      targetMonth: row.target_month,
      expected: row.expected_real,
    }));

    const repo = this.db.getRepository(NewCenterPrediction);
    const saved = await repo.save(
      repo.create({
        requestedBy: user.id,
        modelVersion: response.modelVersion,
        lastMonth: monthEpoch(response.lastMonth),
        accreditationMonth: monthEpoch(dto.accreditationMonth),
        provincePsgc: dto.provincePsgc,
        input: {
          backend: dto,
          model: center,
          province: provinceMap,
          qualifications: qualifications.filter((q) => q),
        },
        result: {
          modelVersion: response.modelVersion,
          lastMonth: response.lastMonth,
          latestAccreditationMonth: meta.latestAccreditationMonth,
          chanceAnyCandidates: prediction.chance_any_candidates,
          firstYearExpected: prediction.first_year_expected_real,
          monthly: prediction.monthly,
          accuracy: meta.testAccuracy,
        },
        createdAt: nowEpoch(),
      }),
    );

    this.log.log(
      `new center prediction ${saved.id}: province ${dto.provincePsgc}, ${rawQualIds.length} qualifications, ` +
        `chance ${prediction.chance_any_candidates}, first year ${prediction.first_year_expected_real}`,
    );

    return {
      id: saved.id,
      modelVersion: response.modelVersion,
      lastMonth: response.lastMonth,
      latestAccreditationMonth: meta.latestAccreditationMonth,
      chanceAnyCandidates: prediction.chance_any_candidates,
      firstYearExpected: prediction.first_year_expected_real,
      monthly,
      accuracy: meta.testAccuracy,
    };
  }

  private async modelMeta(): Promise<ModelMeta> {
    if (this.metaCache && Date.now() - this.metaCache.at < 30_000) return this.metaCache.value;
    const value = await this.request<ModelMeta>('/meta');
    this.metaCache = { at: Date.now(), value };
    return value;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const base = this.config.get<string>('NEW_CENTER_MODEL_URL', 'http://localhost:8010').replace(/\/$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(`${base}${path}`, { ...init, signal: controller.signal });
      const text = await res.text();
      if (!res.ok) {
        throw new ServiceUnavailableException(
          `New Center Model service returned ${res.status}: ${text.slice(0, 200)}`,
        );
      }
      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException('New Center Model service is unavailable');
    } finally {
      clearTimeout(timer);
    }
  }
}
