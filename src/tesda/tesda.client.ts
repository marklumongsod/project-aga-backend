/**
 * Client for TESDA's Assessor Coverage API (https://sap-sis.tesda.gov.ph/swagger/index.html).
 *   - /api/v1/public/*   centers and their qualifications, no key
 *   - /api/v1/coverage/* graduates per school and the time of TESDA's nightly recalculation, X-Api-Key header
 * Only counts and center details are read. The API has no learner details and none are requested.
 */

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

export interface TesdaSchoolGraduates {
  schoolId: number;
  schoolName: string | null;
  province: string | null;
  lat: number;
  lon: number;
  graduates: number;
}

export interface TesdaMonthGraduates {
  /** graduates of schools that have no map position (not in `schools`) */
  notOnMap: number;
  total: number;
  schools: TesdaSchoolGraduates[];
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

/** The API returns at most 200 rows per page whatever `limit` says. */
const PAGE = 200;
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

export function parseGraduates(raw: unknown): TesdaMonthGraduates {
  const r = (raw ?? {}) as Record<string, unknown>;
  const schools: TesdaSchoolGraduates[] = [];
  for (const s of Array.isArray(r.schools) ? (r.schools as Array<Record<string, unknown>>) : []) {
    const schoolId = num(s?.schoolId);
    const lat = num(s?.latitude);
    const lon = num(s?.longitude);
    const graduates = num(s?.graduates);
    if (schoolId === null || lat === null || lon === null || graduates === null || graduates <= 0) continue;
    if (!inPhilippines(lat, lon)) continue;
    schools.push({ schoolId, schoolName: text(s.schoolName), province: text(s.province), lat, lon, graduates: Math.round(graduates) });
  }
  return { notOnMap: num(r.notOnMap) ?? 0, total: num(r.total) ?? 0, schools };
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
  private get(path: string, withKey = false): Promise<unknown> {
    const job = this.queue.then(async () => {
      const gap = this.lastAt + this.minIntervalMs - Date.now();
      if (gap > 0) await this.sleep(gap);
      try {
        return await this.send(path, withKey);
      } finally {
        this.lastAt = Date.now();
      }
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  /** GET JSON with a timeout; 429/5xx gateway errors and network errors are retried with backoff (long for 429). */
  private async send(path: string, withKey: boolean): Promise<unknown> {
    if (withKey && !this.apiKey) throw new TesdaApiError(`${path} needs TESDA_API_KEY`);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (withKey && this.apiKey) headers['X-Api-Key'] = this.apiKey;
    for (let attempt = 0; ; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
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
      const page = (await this.get(`/api/v1/public/centers?limit=${PAGE}&offset=${offset}`)) as { total?: unknown; items?: unknown };
      if (!Array.isArray(page?.items)) throw new TesdaApiError('TESDA API /api/v1/public/centers returned an unexpected body');
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
    const list = await this.get('/api/v1/public/qualifications');
    if (!Array.isArray(list)) throw new TesdaApiError('TESDA API /api/v1/public/qualifications returned an unexpected body');
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
          `/api/v1/public/centers?qualification=${encodeURIComponent(name)}&limit=${PAGE}&offset=${offset}`,
        )) as { total?: unknown; items?: unknown };
        if (!Array.isArray(page?.items)) throw new TesdaApiError('TESDA API /api/v1/public/centers returned an unexpected body');
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

  /** Graduates finishing in one month ("YYYY-MM-01"), per school. Needs the key. */
  async graduatesByMonth(month: string): Promise<TesdaMonthGraduates> {
    return parseGraduates(await this.get(`/api/v1/coverage/graduates-by-school?month=${encodeURIComponent(month)}`, true));
  }

  /** When TESDA last recalculated its data (epoch seconds). Needs the key. */
  async lastRun(): Promise<number | null> {
    const r = (await this.get('/api/v1/coverage/run', true)) as { runDate?: unknown } | null;
    return tesdaEpoch(r?.runDate, 'utc');
  }
}
