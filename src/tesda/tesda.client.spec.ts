import { parseCenter, parseQualifications, parseStudent, TesdaApiError, TesdaClient, tesdaEpoch } from './tesda.client';
import { manilaMonthStart } from './manila-months';

const center = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: `CENTER ${id}`,
  address: 'Poblacion',
  city: 'Bucay',
  province: 'Abra',
  region: 'CAR',
  phone: '(074) 6140077',
  email: '',
  website: '',
  latitude: 17.54405,
  longitude: 120.719,
  distanceKm: null,
  accreditedUntil: '2027-05-19T00:00:00',
  ...extra,
});

type Reply = { status: number; body?: unknown };

/** A fake TESDA server: `route(url)` gives the reply; every call is recorded with its headers. */
function fake(route: (url: string, n: number) => Reply) {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const fetchFn = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers });
    const r = route(url, calls.length);
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return { fetchFn, calls, sleeps, sleep };
}

describe('tesdaEpoch', () => {
  it('reads a date with no offset as Asia/Manila midnight', () => {
    expect(tesdaEpoch('2027-05-19T00:00:00')).toBe(Date.parse('2027-05-18T16:00:00Z') / 1000);
  });
  it('reads the nightly run time as UTC when asked', () => {
    expect(tesdaEpoch('2026-10-26T17:24:36.9066667', 'utc')).toBe(Math.floor(Date.parse('2026-10-26T17:24:36.906Z') / 1000));
  });
  it('gives null for anything else', () => {
    expect(tesdaEpoch(null)).toBeNull();
    expect(tesdaEpoch('soon')).toBeNull();
  });
});

describe('parsing', () => {
  it('keeps a usable center and turns empty strings into null', () => {
    const c = parseCenter(center(4355))!;
    expect(c).toMatchObject({ id: 4355, lat: 17.54405, lon: 120.719, email: null, website: null });
    expect(c.accreditedUntil).toBe(tesdaEpoch('2027-05-19T00:00:00'));
  });
  it('drops a center with no id, no name or a point outside the Philippines', () => {
    expect(parseCenter(center(0))).toBeNull();
    expect(parseCenter(center(1, { name: ' ' }))).toBeNull();
    expect(parseCenter(center(1, { latitude: 35.6, longitude: 139.7 }))).toBeNull();
    expect(parseCenter(center(1, { latitude: null }))).toBeNull();
  });
  it('keeps the longest accreditation when a qualification is listed twice', () => {
    const q = parseQualifications({
      qualifications: [
        { qualification: 'Cookery II', accreditedUntil: '2026-01-01T00:00:00' },
        { qualification: 'cookery II', accreditedUntil: '2028-01-01T00:00:00' },
        { qualification: '' },
      ],
    });
    expect(q).toEqual([{ qualification: 'cookery II', accreditedUntil: tesdaEpoch('2028-01-01T00:00:00') }]);
  });
  it('keeps only the point, precision, qualification and month of a student row', () => {
    const s = parseStudent({
      region: 'NCR',
      province: 'CAMANAVA',
      city: 'Caloocan City',
      barangay: 'Barangay 156',
      qualification: 'Cookery II',
      school: 'A SCHOOL',
      finishMonth: '2026-12',
      latitude: 14.71554,
      longitude: 121.0065636,
      precision: 'city',
      nearestCenter: 'A CENTER',
      nearestCenterKm: 20,
    });
    expect(s).toEqual({ lat: 14.71554, lon: 121.0065636, precision: 'city', qualification: 'Cookery II', month: manilaMonthStart('2026-12') });
  });
  it('drops a student row with no usable point, qualification or month', () => {
    const ok = { qualification: 'Cookery II', finishMonth: '2026-12', latitude: 14.7, longitude: 121, precision: 'province' };
    expect(parseStudent(ok)!.precision).toBe('province');
    expect(parseStudent({ ...ok, latitude: null })).toBeNull();
    expect(parseStudent({ ...ok, latitude: 35.6, longitude: 139.7 })).toBeNull();
    expect(parseStudent({ ...ok, qualification: '' })).toBeNull();
    expect(parseStudent({ ...ok, finishMonth: null })).toBeNull();
  });
});

describe('TesdaClient', () => {
  it('pages through every center 200 at a time, one request after the other', async () => {
    const f = fake((url) => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      const items = Array.from({ length: offset === 400 ? 5 : 200 }, (_, i) => center(offset + i + 1));
      return { status: 200, body: { total: 405, items } };
    });
    const r = await new TesdaClient('https://tesda.test/', { apiKey: 'k', fetchFn: f.fetchFn, sleep: f.sleep }).centers();
    expect(r.centers).toHaveLength(405);
    expect(f.calls.map((c) => c.url)).toEqual([
      'https://tesda.test/api/v1/centers?limit=200&offset=0',
      'https://tesda.test/api/v1/centers?limit=200&offset=200',
      'https://tesda.test/api/v1/centers?limit=200&offset=400',
    ]);
  });

  it('builds each center qualification list from one paged list per qualification', async () => {
    const f = fake((url) => {
      if (url.endsWith('/api/v1/qualifications'))
        return { status: 200, body: [{ qualification: 'Cookery II', centers: 2 }, { qualification: 'Bread and Pastry Production II', centers: 1 }] };
      const q = new URL(url).searchParams.get('qualification');
      const items = q === 'Cookery II' ? [center(1), center(2)] : [center(2)];
      return { status: 200, body: { total: items.length, items } };
    });
    const by = await new TesdaClient('https://tesda.test', { apiKey: 'k', fetchFn: f.fetchFn, sleep: f.sleep }).centerQualifications();
    expect(f.calls).toHaveLength(3);
    expect(by.get(1)!.map((q) => q.qualification)).toEqual(['Cookery II']);
    expect(by.get(2)!.map((q) => q.qualification)).toEqual(['Cookery II', 'Bread and Pastry Production II']);
  });

  it('waits long after a 429 (the API sends no Retry-After), then succeeds', async () => {
    const f = fake((_url, n) => (n === 1 ? { status: 429 } : { status: 200, body: [] }));
    const client = new TesdaClient('https://tesda.test', { apiKey: 'k', fetchFn: f.fetchFn, sleep: f.sleep, rateLimitDelayMs: 15000, minIntervalMs: 0 });
    await expect(client.qualificationNames()).resolves.toEqual([]);
    expect(f.calls).toHaveLength(2);
    expect(Math.min(...f.sleeps)).toBeGreaterThanOrEqual(15000 * 0.75);
  });

  it('does not retry a 401 and never puts the key in the error', async () => {
    const f = fake(() => ({ status: 401 }));
    const client = new TesdaClient('https://tesda.test', { apiKey: 'secret-key', fetchFn: f.fetchFn, sleep: f.sleep });
    const err = await client.lastRun().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TesdaApiError);
    expect((err as TesdaApiError).status).toBe(401);
    expect((err as Error).message).not.toContain('secret-key');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.headers!['X-Api-Key']).toBe('secret-key');
  });

  it('refuses any call without a key, before a request', async () => {
    const f = fake(() => ({ status: 200, body: {} }));
    await expect(new TesdaClient('https://tesda.test', { fetchFn: f.fetchFn }).centers()).rejects.toThrow(/TESDA_API_KEY/);
    expect(f.calls).toHaveLength(0);
  });

  it('pages through the students with nextOffset and sums them, keeping no row', async () => {
    const row = (q: string, month = '2026-12') => ({ qualification: q, finishMonth: month, latitude: 14.7, longitude: 121, precision: 'city', barangay: 'X' });
    const f = fake((url) => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      return offset === 0
        ? { status: 200, body: { total: 5, hasMore: true, nextOffset: 3, items: [row('Cookery II'), row('cookery II'), row('Driving II')] } }
        : { status: 200, body: { total: 5, hasMore: false, nextOffset: null, items: [row('Cookery II', '2027-01'), { qualification: 'Cookery II' }] } };
    });
    const r = await new TesdaClient('https://tesda.test', { apiKey: 'k', fetchFn: f.fetchFn, sleep: f.sleep }).upcomingGraduates();
    expect(f.calls.map((c) => c.url)).toEqual([
      'https://tesda.test/api/v1/students/all?limit=2000&offset=0',
      'https://tesda.test/api/v1/students/all?limit=2000&offset=3',
    ]);
    expect(r.total).toBe(5);
    expect(r.skipped).toBe(1);
    expect(r.groups.map((g) => [g.qualification, g.month, g.graduates])).toEqual([
      ['Cookery II', manilaMonthStart('2026-12'), 2],
      ['Driving II', manilaMonthStart('2026-12'), 1],
      ['Cookery II', manilaMonthStart('2027-01'), 1],
    ]);
    expect(Object.keys(r.groups[0]!).sort()).toEqual(['graduates', 'lat', 'lon', 'month', 'precision', 'qualification']);
  });
});
