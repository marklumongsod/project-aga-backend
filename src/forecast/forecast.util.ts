import { manilaMonthStart } from '../common/quarter';

export type ForecastLevel = 'national' | 'region' | 'province' | 'center';
export const FORECAST_LEVELS: ForecastLevel[] = ['national', 'region', 'province', 'center'];

export type ForecastTargetType = 'national' | 'region' | 'province' | 'center' | 'excluded';
export const FORECAST_TARGET_TYPES: ForecastTargetType[] = [
  'national',
  'region',
  'province',
  'center',
  'excluded',
];

/** One row of `forecasts_<month>.json` as written by `Forecast_Model/forecast.py`. */
export interface RawForecastRow {
  forecast_month: string;
  horizon: number;
  target_month: string;
  level: ForecastLevel;
  place_id: string;
  parent_id?: string | null;
  forecast_sample: number;
  forecast_real: number;
}

/** One row of `forecast_places.csv`. */
export interface PlaceMapRow {
  level: ForecastLevel;
  sourcePlaceId: string;
  parentSourceId: string | null;
  name: string | null;
  targetType: ForecastTargetType;
  targetCode: string;
  share: number;
  note: string | null;
}

const MONTH = /^(\d{4})-(\d{2})$/;
const MANILA_OFFSET_MS = 8 * 3600 * 1000;

export function parseMonthLabel(label: string): { year: number; month: number } {
  const match = MONTH.exec(String(label ?? '').trim());
  if (!match) throw new Error(`Invalid month "${label}"; expected YYYY-MM`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error(`Invalid month "${label}"`);
  return { year, month };
}

/** "2026-10" + 1 -> "2026-11"; "2026-12" + 1 -> "2027-01". */
export function addMonthsLabel(label: string, months: number): string {
  const { year, month } = parseMonthLabel(label);
  const d = new Date(Date.UTC(year, month - 1 + months, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Epoch seconds of 00:00 Asia/Manila on the first day of the label's month. */
export function monthEpoch(label: string): number {
  const { year, month } = parseMonthLabel(label);
  return manilaMonthStart(year, month);
}

/** Epoch seconds -> "YYYY-MM" in Asia/Manila. */
export function monthLabel(epochSeconds: number): string {
  const d = new Date(Number(epochSeconds) * 1000 + MANILA_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Epoch seconds of the first day of the previous month in Asia/Manila, used for the stale flag. */
export function previousMonthStart(nowMs: number = Date.now()): number {
  const d = new Date(nowMs + MANILA_OFFSET_MS);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  return month === 1 ? manilaMonthStart(year - 1, 12) : manilaMonthStart(year, month - 1);
}

/**
 * Small RFC 4180 parser: commas, quoted fields, escaped quotes and CRLF/LF. The mapping file contains
 * center names with commas, so splitting on commas is not enough.
 */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) {
      if (c === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function parseForecastJson(text: string): RawForecastRow[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('Forecast JSON must be an array');
  return parsed as RawForecastRow[];
}

export function parsePlacesCsv(text: string): PlaceMapRow[] {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('Forecast places CSV is empty');
  const header = rows[0].map((h) => h.trim());
  const required = ['level', 'source_place_id', 'target_type', 'target_code', 'share'];
  for (const column of required) {
    if (!header.includes(column)) throw new Error(`Forecast places CSV is missing ${column}`);
  }
  const index = (name: string) => header.indexOf(name);
  const out: PlaceMapRow[] = [];
  for (const row of rows.slice(1)) {
    if (row.every((v) => v.trim() === '')) continue;
    const get = (name: string) => (index(name) >= 0 ? (row[index(name)] ?? '').trim() : '');
    const level = get('level') as ForecastLevel;
    const targetType = get('target_type') as ForecastTargetType;
    if (!FORECAST_LEVELS.includes(level)) throw new Error(`Invalid mapping level "${level}"`);
    if (!FORECAST_TARGET_TYPES.includes(targetType)) throw new Error(`Invalid target_type "${targetType}"`);
    const share = Number(get('share') || '0');
    if (!Number.isFinite(share) || share < 0 || share > 1) {
      throw new Error(`Invalid share "${get('share')}" for ${level} ${get('source_place_id')}`);
    }
    out.push({
      level,
      sourcePlaceId: get('source_place_id'),
      parentSourceId: get('parent_source_id') || null,
      name: get('name') || null,
      targetType,
      targetCode: get('target_code') || '-',
      share,
      note: get('note') || null,
    });
  }
  return out;
}

export function mappingKey(level: string, sourcePlaceId: string): string {
  return `${level}:${sourcePlaceId}`;
}

export function groupPlaceMappings(rows: PlaceMapRow[]): Map<string, PlaceMapRow[]> {
  const map = new Map<string, PlaceMapRow[]>();
  for (const row of rows) {
    const key = mappingKey(row.level, row.sourcePlaceId);
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return map;
}

/** Every non-excluded mapping group must add up to 1; an all-excluded group is allowed. */
export function assertMappingShares(map: Map<string, PlaceMapRow[]>): void {
  for (const [key, rows] of map) {
    const active = rows.filter((r) => r.targetType !== 'excluded');
    if (active.length === 0) continue;
    const total = active.reduce((n, r) => n + r.share, 0);
    if (Math.abs(total - 1) > 1e-6) {
      throw new Error(`Mapping shares for ${key} add up to ${total}, expected 1`);
    }
  }
}

export interface ForecastValidation {
  forecastMonth: string;
  targetMonths: string[];
  /** level -> place ids */
  places: Map<ForecastLevel, Set<string>>;
  /** level -> raw row count */
  counts: Record<ForecastLevel, number>;
  /** `${target_month}|${horizon}` -> national sample forecast */
  national: Map<string, number>;
  /** `${target_month}|${horizon}` -> sum of the region sample forecasts */
  regionSums: Map<string, number>;
}

/**
 * Validate the model output before touching the database. The Python job already applies the horizon, cap,
 * national-sum and sample-rate rules; this is the backend's guard against a truncated or inconsistent file.
 */
export function validateForecastRows(rows: RawForecastRow[], sampleRate: number): ForecastValidation {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Forecast JSON is empty');
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('sample_rate must be greater than 0');

  const forecastMonth = String(rows[0]?.forecast_month ?? '');
  parseMonthLabel(forecastMonth);

  const places: Record<ForecastLevel, Set<string>> = {
    national: new Set(),
    region: new Set(),
    province: new Set(),
    center: new Set(),
  };
  const counts: Record<ForecastLevel, number> = { national: 0, region: 0, province: 0, center: 0 };
  const horizons = new Map<string, Set<number>>();
  const seen = new Set<string>();
  const national = new Map<string, number>();
  const regionSums = new Map<string, number>();
  const targetMonths = new Set<string>();

  for (const row of rows) {
    if (!row || typeof row !== 'object') throw new Error('Forecast JSON contains a non-object row');
    if (row.forecast_month !== forecastMonth) {
      throw new Error(`Mixed forecast months: ${forecastMonth} and ${row.forecast_month}`);
    }
    const level = row.level;
    if (!FORECAST_LEVELS.includes(level)) throw new Error(`Invalid forecast level "${level}"`);
    const horizon = Number(row.horizon);
    if (!Number.isInteger(horizon) || horizon < 1 || horizon > 6) {
      throw new Error(`Invalid horizon "${row.horizon}" for ${level} ${row.place_id}`);
    }
    const targetMonth = String(row.target_month ?? '');
    parseMonthLabel(targetMonth);
    if (targetMonth !== addMonthsLabel(forecastMonth, horizon)) {
      throw new Error(`target_month ${targetMonth} is not ${forecastMonth} + ${horizon}`);
    }
    const placeId = String(row.place_id ?? '');
    if (!placeId) throw new Error(`Missing place_id for ${level}`);
    const sample = Number(row.forecast_sample);
    const real = Number(row.forecast_real);
    if (!Number.isFinite(sample) || sample < 0) throw new Error(`Invalid forecast_sample for ${level} ${placeId}`);
    if (!Number.isFinite(real) || real < 0) throw new Error(`Invalid forecast_real for ${level} ${placeId}`);
    if (Math.abs(real - Math.round(sample / sampleRate)) > 1) {
      throw new Error(`forecast_real ${real} is not forecast_sample ${sample} / ${sampleRate} for ${level} ${placeId}`);
    }

    const key = `${level}|${placeId}|${targetMonth}|${horizon}`;
    if (seen.has(key)) throw new Error(`Duplicate forecast row ${key}`);
    seen.add(key);

    places[level].add(placeId);
    counts[level] += 1;
    targetMonths.add(targetMonth);

    const placeKey = `${level}|${placeId}`;
    const set = horizons.get(placeKey) ?? new Set<number>();
    set.add(horizon);
    horizons.set(placeKey, set);

    const targetKey = `${targetMonth}|${horizon}`;
    if (level === 'national') national.set(targetKey, sample);
    if (level === 'region') regionSums.set(targetKey, (regionSums.get(targetKey) ?? 0) + sample);
  }

  for (const [placeKey, set] of horizons) {
    if (set.size !== 6 || ![1, 2, 3, 4, 5, 6].every((h) => set.has(h))) {
      throw new Error(`Place ${placeKey} does not have all six horizons`);
    }
  }
  for (const [key, expected] of national) {
    const actual = regionSums.get(key);
    if (actual === undefined) throw new Error(`No regions for national target ${key}`);
    if (Math.abs(actual - expected) > 0.2) {
      throw new Error(`National ${key} is ${expected}, regions add up to ${actual}`);
    }
  }
  for (const key of regionSums.keys()) {
    if (!national.has(key)) throw new Error(`Regions have target ${key} but national does not`);
  }

  return {
    forecastMonth,
    targetMonths: [...targetMonths].sort(),
    places: new Map(Object.entries(places).map(([k, v]) => [k as ForecastLevel, v])),
    counts,
    national,
    regionSums,
  };
}
