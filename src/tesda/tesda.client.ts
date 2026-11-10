/**
 * Client for TESDA's Assessor Coverage API (https://sap-sis.tesda.gov.ph/swagger/index.html). Every call sends the
 * X-Api-Key header.
 *   - /api/v1/centers, /api/v1/qualifications   centers and what they assess (any key)
 *   - /api/v1/students/all                       upcoming graduates (next 6 months), one row each (key with the
 *                                                students permission). The rows carry no names or ids; only the point,
 *                                                its precision, the qualification and the finish month are read, and
 *                                                they are summed before anything is stored (see `upcomingGraduates`).
 *   - /api/v1/coverage/run                       the time of TESDA's nightly recalculation (not in the spec, still served)
 */
import { manilaMonthStart } from './manila-months';

export interface TesdaCenter {
  id: number;
  name: string;
  address: string | null;
  city: string | null;
  province: string | null;
  region: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  lat: number;
  lon: number;
  /** epoch seconds */
  accreditedUntil: number | null;
}

export interface TesdaCenterQualification {
  qualification: string;
  accreditedUntil: number | null;
}

/** Upcoming graduates at one point, of one qualification, finishing in one month. A count, never a person. */
export interface TesdaGraduateGroup {
  lat: number;
  lon: number;
  /** 'city' = the point is the graduate's town; 'province' = only the province is known (the point is its centre) */
  precision: 'city' | 'province';
  qualification: string;
  /** epoch seconds of 00:00 Asia/Manila on the 1st of the finish month */
  month: number;
  graduates: number;
}

export interface TesdaUpcomingGraduates {
  /** the API's own total */
  total: number;
  groups: TesdaGraduateGroup[];
  /** rows with no usable point, qualification or finish month */
  skipped: number;
}

export class TesdaApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

type FetchFn = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** The API returns at most 200 centers per page whatever `limit` says. */
const PAGE = 200;
/** ... and at most 2,000 students. */
const STUDENT_PAGE = 2000;
/** A deep students page takes about 30 s (offset paging on TESDA's side). */
const STUDENT_TIMEOUT_MS = 120_000;
const RETRY_STATUS = new Set([429, 502, 503, 504]);
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Philippine bounding box (the same one the ETL uses). Anything outside is a bad coordinate. */
const inPhilippines = (lat: number, lon: number) => lat > 4.4 && lat < 21.5 && lon > 116.5 && lon < 127.0;

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * TESDA timestamps have no offset ("2027-05-19T00:00:00"). Accreditation dates are calendar dates in the Philippines,
 * so they are read as Asia/Manila (UTC+8, no daylight saving). The nightly run time is UTC on the server.
 */
export function tesdaEpoch(v: unknown, zone: 'manila' | 'utc' = 'manila'): number | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(v);
  const iso = hasOffset ? v : `${v.length === 10 ? `${v}T00:00:00` : v}${zone === 'manila' ? '+08:00' : 'Z'}`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** One center row, or null when it can't be used (no id or a coordinate outside the Philippines). */
export function parseCenter(raw: unknown): TesdaCenter | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return null;
  const id = num(r.id);
  const lat = num(r.latitude);
  const lon = num(r.longitude);
  const name = text(r.name);
  if (id === null || !Number.isInteger(id) || id <= 0 || lat === null || lon === null || !name) return null;
  if (!inPhilippines(lat, lon)) return null;
  return {
    id,
    name,
    address: text(r.address),
    city: text(r.city),
    province: text(r.province),
    region: text(r.region),
    phone: text(r.phone),
    email: text(r.email),
    website: text(r.website),
    lat,
    lon,
    accreditedUntil: tesdaEpoch(r.accreditedUntil),
  };
}

export function parseQualifications(raw: unknown): TesdaCenterQualification[] {
  const list = (raw as { qualifications?: unknown } | null)?.qualifications;
  if (!Array.isArray(list)) return [];
  const out = new Map<string, TesdaCenterQualification>();
  for (const q of list as Array<Record<string, unknown>>) {
    const name = text(q?.qualification);
    if (!name) continue;
    const until = tesdaEpoch(q.accreditedUntil);
    const prev = out.get(name.toLowerCase());
    // The same qualification listed twice: keep the accreditation that runs longest.
    if (!prev || (until ?? 0) > (prev.accreditedUntil ?? 0)) out.set(name.toLowerCase(), { qualification: name, accreditedUntil: until });
  }
  return [...out.values()];
}

/**
 * The parts of one student row this app uses: point, precision, qualification, finish month. Everything else in the
 * row (barangay, school, nearest center) is dropped here. Null when the row can't be placed or dated.
 */
export function parseStudent(raw: unknown): Omit<TesdaGraduateGroup, 'graduates'> | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return null;
  const lat = num(r.latitude);
  const lon = num(r.longitude);
  const qualification = text(r.qualification);
  const month = typeof r.finishMonth === 'string' ? manilaMonthStart(r.finishMonth) : null;
  if (lat === null || lon === null || !qualification || month === null || !inPhilippines(lat, lon)) return null;
  return { lat, lon, precision: r.precision === 'city' ? 'city' : 'province', qualification, month };
}

export interface TesdaClientOptions {
  apiKey?: string;
  timeoutMs?: number;
  fetchFn?: FetchFn;
  retries?: number;
  baseDelayMs?: number;
  /** wait at least this long between two requests (the API rate-limits with 429 and no Retry-After) */
  minIntervalMs?: number;
  /** first wait after a 429; doubles each attempt */
  rateLimitDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class TesdaClient {
  private readonly base: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;
  private readonly retries: number;
  private readonly baseDelayMs: number;
  private readonly minIntervalMs: number;
  private readonly rateLimitDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** requests go out one at a time, `minIntervalMs` apart */
  private queue: Promise<unknown> = Promise.resolve();
  private lastAt = 0;

  constructor(baseUrl: string, opts: TesdaClientOptions = {}) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 20000;
    this.fetchFn = opts.fetchFn ?? (fetch as unknown as FetchFn);
    this.retries = opts.retries ?? 3;
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.minIntervalMs = opts.minIntervalMs ?? 250;
    this.rateLimitDelayMs = opts.rateLimitDelayMs ?? 15000;
    this.sleep = opts.sleep ?? wait;
  }

  get hasKey() {
    return !!this.apiKey;
  }

  /** GET JSON, one request at a time and `minIntervalMs` apart, so a sync never bursts at TESDA's server. */
  private get(path: string, timeoutMs = this.timeoutMs): Promise<unknown> {
    const job = this.queue.then(async () => {
      const gap = this.lastAt + this.minIntervalMs - Date.now();
      if (gap > 0) await this.sleep(gap);
      try {
        return await this.send(path, timeoutMs);
      } finally {
        this.lastAt = Date.now();
      }
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  /** GET JSON with a timeout; 429/5xx gateway errors and network errors are retried with backoff (long for 429). */
  private async send(path: string, timeoutMs: number): Promise<unknown> {
    if (!this.apiKey) throw new TesdaApiError(`TESDA API ${path.split('?')[0]} needs TESDA_API_KEY`);
    const headers: Record<string, string> = { accept: 'application/json', 'X-Api-Key': this.apiKey };
    for (let attempt = 0; ; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      let status = 0;
      try {
        const res = await this.fetchFn(`${this.base}${path}`, { signal: ctl.signal, headers });
        status = res.status;
        if (res.ok) return await res.json();
        if (!RETRY_STATUS.has(res.status) || attempt >= this.retries) {
          // Never echo the key; the status says enough (401 = missing or wrong key).
          throw new TesdaApiError(`TESDA API ${path.split('?')[0]} returned ${res.status}`, res.status);
        }
      } catch (e) {
        if (e instanceof TesdaApiError) throw e;
        if (attempt >= this.retries) throw new TesdaApiError(`TESDA API ${path.split('?')[0]} failed: ${(e as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
      const base = status === 429 ? this.rateLimitDelayMs : this.baseDelayMs;
      await this.sleep(Math.round(base * 2 ** attempt * (0.75 + Math.random() * 0.5)));
    }
  }

  /** Every center, page by page. `skipped` = rows that had no usable id or coordinates. */
  async centers(): Promise<{ centers: TesdaCenter[]; total: number; skipped: number }> {
    const byId = new Map<number, TesdaCenter>();
    let total = 0;
    let skipped = 0;
    for (let offset = 0; ; offset += PAGE) {
      const page = (await this.get(`/api/v1/centers?limit=${PAGE}&offset=${offset}`)) as { total?: unknown; items?: unknown };
      if (!Array.isArray(page?.items)) throw new TesdaApiError('TESDA API /api/v1/centers returned an unexpected body');
      total = num(page.total) ?? 0;
      for (const raw of page.items) {
        const c = parseCenter(raw);
        if (c) byId.set(c.id, c);
        else skipped++;
      }
      if (!page.items.length || offset + PAGE >= total) break;
    }
    return { centers: [...byId.values()], total, skipped };
  }

  /** Names of the qualifications at least one center can assess ("Cookery II"). */
  async qualificationNames(): Promise<string[]> {
    const list = await this.get('/api/v1/qualifications');
    if (!Array.isArray(list)) throw new TesdaApiError('TESDA API /api/v1/qualifications returned an unexpected body');
    return [...new Set(list.map((q) => text((q as Record<string, unknown>)?.qualification)).filter((q): q is string => !!q))];
  }

  /**
   * Which centers can assess what: one paged list per qualification (about 260 requests for 225 qualifications),
   * not one detail call per center (2,400+, which trips the API's rate limit). All or nothing: if any list fails,
   * this throws and the caller keeps the qualifications it had.
   */
  async centerQualifications(): Promise<Map<number, TesdaCenterQualification[]>> {
    const byCenter = new Map<number, TesdaCenterQualification[]>();
    for (const name of await this.qualificationNames()) {
      for (let offset = 0; ; offset += PAGE) {
        const page = (await this.get(
          `/api/v1/centers?qualification=${encodeURIComponent(name)}&limit=${PAGE}&offset=${offset}`,
        )) as { total?: unknown; items?: unknown };
        if (!Array.isArray(page?.items)) throw new TesdaApiError('TESDA API /api/v1/centers returned an unexpected body');
        for (const raw of page.items as Array<Record<string, unknown>>) {
          const id = num(raw?.id);
          if (id === null) continue;
          const list = byCenter.get(id) ?? [];
          if (!list.some((q) => q.qualification.toLowerCase() === name.toLowerCase()))
            list.push({ qualification: name, accreditedUntil: tesdaEpoch(raw.accreditedUntil) });
          byCenter.set(id, list);
        }
        if (!page.items.length || offset + PAGE >= (num(page.total) ?? 0)) break;
      }
    }
    return byCenter;
  }

  /**
   * Every upcoming graduate (next 6 months), summed per point, precision, qualification and finish month as the pages
   * arrive, so no single row is kept. About 50 pages of 2,000. Needs a key with the students permission.
   */
  async upcomingGraduates(): Promise<TesdaUpcomingGraduates> {
    const groups = new Map<string, TesdaGraduateGroup>();
    let total = 0;
    let skipped = 0;
    for (let offset: number | null = 0; offset !== null; ) {
      const page = (await this.get(`/api/v1/students/all?limit=${STUDENT_PAGE}&offset=${offset}`, STUDENT_TIMEOUT_MS)) as {
        total?: unknown;
        items?: unknown;
        hasMore?: unknown;
        nextOffset?: unknown;
      };
      if (!Array.isArray(page?.items)) throw new TesdaApiError('TESDA API /api/v1/students/all returned an unexpected body');
      total = num(page.total) ?? 0;
      for (const raw of page.items) {
        const s = parseStudent(raw);
        if (!s) {
          skipped++;
          continue;
        }
        const key = `${s.lat}|${s.lon}|${s.precision}|${s.qualification.toLowerCase()}|${s.month}`;
        const g = groups.get(key);
        if (g) g.graduates++;
        else groups.set(key, { ...s, graduates: 1 });
      }
      const next = num(page.nextOffset);
      offset = page.hasMore === true && page.items.length && next !== null && next > offset ? next : null;
    }
    return { total, groups: [...groups.values()], skipped };
  }

  /** When TESDA last recalculated its data (epoch seconds). */
  async lastRun(): Promise<number | null> {
    const r = (await this.get('/api/v1/coverage/run')) as { runDate?: unknown } | null;
    return tesdaEpoch(r?.runDate, 'utc');
  }
}
