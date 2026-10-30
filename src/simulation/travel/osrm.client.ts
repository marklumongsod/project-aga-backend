export interface LonLat {
  lon: number;
  lat: number;
}

/** Row i = source i, column j = destination j. null = OSRM found no route between the two points. */
export interface TableResult {
  minutes: Array<Array<number | null>>;
  km: Array<Array<number | null>>;
  /** metres each source had to be moved to reach a road (a point in the sea snaps far away). Absent if the server omits it. */
  sourceSnapM?: number[];
}

export class OsrmError extends Error {
  constructor(message: string, readonly osrmCode?: string) {
    super(message);
  }
}

/** One maneuver as OSRM reports it (steps=true). */
export interface RawStep {
  distance: number; // m
  duration: number; // s
  name: string;
  mode: string; // driving | ferry | ...
  maneuver: { type: string; modifier?: string; exit?: number; bearing_after?: number; location: [number, number] };
}

export interface RawRoute {
  distanceKm: number;
  minutes: number;
  /** GeoJSON LineString coordinates [lon, lat] */
  coordinates: Array<[number, number]>;
  steps: RawStep[];
  /**
   * Where OSRM actually put the two ends: on the nearest drivable road, `distanceM` from the requested point.
   * The route line starts and ends there, not at the points themselves.
   */
  snapped: { start: SnappedPoint; end: SnappedPoint };
}

export interface SnappedPoint {
  lon: number;
  lat: number;
  distanceM: number;
}

type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface RetryOptions {
  /** extra attempts after the first (default 3) */
  retries?: number;
  /** first wait; doubles each attempt (default 250 ms) */
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Busy / rate-limited / bad gateway: the server asked us to come back later. Retrying right away is what gets an IP blocked. */
const RETRY_STATUS = new Set([429, 502, 503, 504]);
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Minimal client for the OSRM `table` service (https://project-osrm.org/docs/v5.24.0/api/#table-service).
 * Big requests are split so each call carries at most `maxCoordinates` points (OSRM's default limit is 100).
 */
export class OsrmClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 5000,
    private readonly fetchFn: FetchFn = fetch as unknown as FetchFn,
    private readonly maxCoordinates = 100,
    /** URL segment only: OSRM's real profile is fixed by the data it was built from (car.lua, foot.lua) */
    private readonly profile = 'driving',
    retry: RetryOptions = {},
  ) {
    this.retry = { retries: 3, baseDelayMs: 250, maxDelayMs: 4000, sleep: wait, ...retry };
  }

  private readonly retry: Required<RetryOptions>;

  /**
   * GET with a timeout. 429/502/503/504 and network errors are retried with exponential backoff and jitter, and a
   * `Retry-After` header (seconds) is honoured, so a busy or rate-limiting server is never hammered.
   */
  private async send<T>(url: string): Promise<{ ok: boolean; status: number; body: T }> {
    const { retries, baseDelayMs, maxDelayMs, sleep } = this.retry;
    for (let attempt = 0; ; attempt++) {
      let retryAfterMs: number | null = null;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
      try {
        const res = await this.fetchFn(url, { signal: ctl.signal });
        if (!(RETRY_STATUS.has(res.status) && attempt < retries)) {
          const body = (await res.json().catch(() => ({}))) as T;
          return { ok: res.ok, status: res.status, body };
        }
        const ra = Number(res.headers?.get('retry-after'));
        retryAfterMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30_000) : null;
      } catch (e) {
        if (attempt >= retries) throw new OsrmError(`OSRM request failed: ${(e as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      await sleep(retryAfterMs ?? Math.round(backoff * (0.75 + Math.random() * 0.5)));
    }
  }

  async table(sources: LonLat[], destinations: LonLat[]): Promise<TableResult> {
    const minutes: Array<Array<number | null>> = sources.map(() => new Array(destinations.length).fill(null));
    const km: Array<Array<number | null>> = sources.map(() => new Array(destinations.length).fill(null));
    if (!sources.length || !destinations.length) return { minutes, km };
    const sourceSnapM: number[] = new Array(sources.length).fill(NaN);

    // Give the smaller side its full size and the rest of the budget to the other.
    const room = this.maxCoordinates;
    const sChunk = sources.length <= destinations.length ? Math.min(sources.length, room >> 1) : room - Math.min(destinations.length, room >> 1);
    const dChunk = room - sChunk;
    for (let s = 0; s < sources.length; s += sChunk) {
      for (let d = 0; d < destinations.length; d += dChunk) {
        const part = await this.request(sources.slice(s, s + sChunk), destinations.slice(d, d + dChunk));
        part.minutes.forEach((row, i) =>
          row.forEach((v, j) => {
            minutes[s + i]![d + j] = v;
            km[s + i]![d + j] = part.km[i]![j]!;
          }),
        );
        part.sourceSnapM?.forEach((m, i) => {
          if (Number.isNaN(sourceSnapM[s + i]!)) sourceSnapM[s + i] = m;
        });
      }
    }
    return { minutes, km, sourceSnapM: sourceSnapM.every((m) => !Number.isNaN(m)) ? sourceSnapM : undefined };
  }

  /** Fastest road + ferry route between two points, with geometry and maneuvers. null when OSRM finds no route. */
  async route(from: LonLat, to: LonLat): Promise<RawRoute | null> {
    const coords = [from, to].map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    const url = `${this.baseUrl.replace(/\/$/, '')}/route/v1/${this.profile}/${coords}?overview=full&geometries=geojson&steps=true&alternatives=false`;
    const { ok, status, body } = await this.send<{
      code?: string;
      message?: string;
      waypoints?: Array<{ location: [number, number]; distance: number }>;
      routes?: Array<{
        distance: number;
        duration: number;
        geometry: { coordinates: Array<[number, number]> };
        legs: Array<{ steps: RawStep[] }>;
      }>;
    }>(url);
    if (body.code === 'NoRoute') return null;
    const r = body.routes?.[0];
    if (!ok || body.code !== 'Ok' || !r) {
      throw new OsrmError(`OSRM ${status}: ${body.code ?? 'no code'} ${body.message ?? ''}`.trim(), body.code);
    }
    const snap = (w?: { location: [number, number]; distance: number }): SnappedPoint => ({
      lon: w?.location[0] ?? 0,
      lat: w?.location[1] ?? 0,
      distanceM: Math.round(w?.distance ?? 0),
    });
    return {
      distanceKm: r.distance / 1000,
      minutes: r.duration / 60,
      coordinates: r.geometry.coordinates,
      steps: r.legs.flatMap((l) => l.steps),
      snapped: { start: snap(body.waypoints?.[0]), end: snap(body.waypoints?.[1]) },
    };
  }

  /** The nearest point on a drivable road to `p`, or null when OSRM finds none. `distanceM` is how far it moved. */
  async nearest(p: LonLat): Promise<(SnappedPoint & { road: string | null }) | null> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/nearest/v1/${this.profile}/${p.lon.toFixed(6)},${p.lat.toFixed(6)}?number=1`;
    const { ok, status, body } = await this.send<{
      code?: string;
      message?: string;
      waypoints?: Array<{ location: [number, number]; distance: number; name?: string }>;
    }>(url);
    if (body.code === 'NoSegment') return null;
    const w = body.waypoints?.[0];
    if (!ok || body.code !== 'Ok' || !w) {
      throw new OsrmError(`OSRM ${status}: ${body.code ?? 'no code'} ${body.message ?? ''}`.trim(), body.code);
    }
    return { lon: w.location[0], lat: w.location[1], distanceM: Math.round(w.distance), road: w.name ? w.name : null };
  }

  private async request(sources: LonLat[], destinations: LonLat[]): Promise<TableResult> {
    const all = [...sources, ...destinations];
    const coords = all.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    const src = sources.map((_, i) => i).join(';');
    const dst = destinations.map((_, i) => sources.length + i).join(';');
    const url = `${this.baseUrl.replace(/\/$/, '')}/table/v1/${this.profile}/${coords}?sources=${src}&destinations=${dst}&annotations=duration,distance`;

    const { ok, status, body } = await this.send<{
      code?: string;
      message?: string;
      durations?: Array<Array<number | null>>;
      distances?: Array<Array<number | null>>;
      sources?: Array<{ distance?: number }>;
    }>(url);
    if (!ok || body.code !== 'Ok' || !body.durations) {
      throw new OsrmError(`OSRM ${status}: ${body.code ?? 'no code'} ${body.message ?? ''}`.trim());
    }
    return {
      minutes: body.durations.map((r) => r.map((v) => (v === null ? null : v / 60))),
      km: (body.distances ?? body.durations.map((r) => r.map(() => null))).map((r) => r.map((v) => (v === null ? null : v / 1000))),
      sourceSnapM: body.sources?.every((x) => typeof x.distance === 'number') ? body.sources.map((x) => x.distance as number) : undefined,
    };
  }
}
