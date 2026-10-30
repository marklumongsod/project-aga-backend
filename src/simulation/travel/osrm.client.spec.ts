import { LonLat, OsrmClient, OsrmError } from './osrm.client';

const pt = (i: number): LonLat => ({ lon: 120 + i / 100, lat: 10 + i / 100 });
const many = (n: number) => Array.from({ length: n }, (_, i) => pt(i));

/** A fake OSRM: duration = 60 s x (source index + 1) x (destination index + 1); distance = 1000 m x the same. */
function fakeOsrm(opts: { nullPair?: [number, number]; code?: string; status?: number } = {}) {
  const calls: string[] = [];
  const fetchFn = async (url: string) => {
    calls.push(url);
    const q = new URL(url).searchParams;
    const src = q.get('sources')!.split(';').map(Number);
    const dst = q.get('destinations')!.split(';').map(Number);
    const mk = (unit: number) => src.map((s, i) => dst.map((d, j) => (opts.nullPair && opts.nullPair[0] === i && opts.nullPair[1] === j ? null : unit * (s + 1) * (d + 1))));
    return {
      ok: (opts.status ?? 200) < 400,
      status: opts.status ?? 200,
      json: async () => ({ code: opts.code ?? 'Ok', durations: mk(60), distances: mk(1000) }),
    };
  };
  return { fetchFn, calls };
}

describe('OsrmClient', () => {
  it('asks for durations and distances and converts to minutes and km', async () => {
    const { fetchFn, calls } = fakeOsrm();
    const t = await new OsrmClient('http://osrm:5000/', 1000, fetchFn).table([pt(0)], [pt(1), pt(2)]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('http://osrm:5000/table/v1/driving/120.000000,10.000000;120.010000,10.010000;120.020000,10.020000');
    expect(calls[0]).toContain('sources=0&destinations=1;2&annotations=duration,distance');
    // fake: source index 0 -> (0+1), destination coordinate indexes 1 and 2 -> (1+1), (2+1)
    expect(t.minutes).toEqual([[2, 3]]);
    expect(t.km).toEqual([[2, 3]]);
  });

  it('keeps null (no route) as null', async () => {
    const { fetchFn } = fakeOsrm({ nullPair: [0, 1] });
    const t = await new OsrmClient('http://x', 1000, fetchFn).table([pt(0)], [pt(1), pt(2)]);
    expect(t.minutes[0]![0]).not.toBeNull();
    expect(t.minutes[0]![1]).toBeNull();
    expect(t.km[0]![1]).toBeNull();
  });

  it('splits big requests so no call carries more than the coordinate limit, and reassembles in order', async () => {
    const { fetchFn, calls } = fakeOsrm();
    const t = await new OsrmClient('http://x', 1000, fetchFn, 100).table([pt(0)], many(250));
    expect(calls.length).toBe(3); // 1 source + 99 destinations per call
    for (const url of calls) expect(new URL(url).pathname.split('/').pop()!.split(';').length).toBeLessThanOrEqual(100);
    expect(t.minutes).toHaveLength(1);
    expect(t.minutes[0]).toHaveLength(250);
    expect(t.minutes[0]!.every((v) => v !== null)).toBe(true);
  });

  it('chunks many sources against one destination (a center reach)', async () => {
    const { fetchFn, calls } = fakeOsrm();
    const t = await new OsrmClient('http://x', 1000, fetchFn, 100).table(many(150), [pt(0)]);
    expect(calls.length).toBe(2);
    expect(t.minutes).toHaveLength(150);
    expect(t.minutes[149]).toHaveLength(1);
  });

  it('returns an empty matrix without calling the server for empty input', async () => {
    const { fetchFn, calls } = fakeOsrm();
    const t = await new OsrmClient('http://x', 1000, fetchFn).table([], [pt(1)]);
    expect(t.minutes).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('throws OsrmError when the server answers with an error', async () => {
    const { fetchFn } = fakeOsrm({ code: 'InvalidQuery', status: 400 });
    await expect(new OsrmClient('http://x', 1000, fetchFn).table([pt(0)], [pt(1)])).rejects.toBeInstanceOf(OsrmError);
  });

  it('throws OsrmError when the server is unreachable', async () => {
    const down = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    await expect(new OsrmClient('http://x', 1000, down).table([pt(0)], [pt(1)])).rejects.toThrow(/OSRM request failed/);
  });
});

describe('OsrmClient profile', () => {
  it('puts the profile in the URL for table and route calls (the server decides the real profile)', async () => {
    const { fetchFn, calls } = fakeOsrm();
    await new OsrmClient('http://foot:5000', 1000, fetchFn, 100, 'walking').table([pt(0)], [pt(1)]);
    expect(calls[0]).toContain('/table/v1/walking/');
    const urls: string[] = [];
    const routeFetch = async (u: string) => {
      urls.push(u);
      return { ok: true, status: 200, json: async () => ({ code: 'NoRoute' }) };
    };
    await new OsrmClient('http://foot:5000', 1000, routeFetch, 100, 'walking').route({ lon: 1, lat: 1 }, { lon: 2, lat: 2 });
    expect(urls[0]).toContain('/route/v1/walking/');
    await new OsrmClient('http://car:5000', 1000, routeFetch).route({ lon: 1, lat: 1 }, { lon: 2, lat: 2 });
    expect(urls[1]).toContain('/route/v1/driving/');
  });
});

describe('OsrmClient.route', () => {
  const body = {
    code: 'Ok',
    waypoints: [
      { location: [121.0282, 14.5209], distance: 123.4 },
      { location: [121.0291, 14.5193], distance: 59.6 },
    ],
    routes: [
      {
        distance: 640,
        duration: 90,
        geometry: { coordinates: [[121.0282, 14.5209], [121.0291, 14.5193]] },
        legs: [{ steps: [{ distance: 640, duration: 90, name: 'East Service Road', mode: 'driving', maneuver: { type: 'depart', location: [121.0282, 14.5209] } }] }],
      },
    ],
  };
  const okFetch = async () => ({ ok: true, status: 200, json: async () => body });

  it('returns the geometry, steps and where each end was snapped to the road', async () => {
    const r = await new OsrmClient('http://x', 1000, okFetch).route({ lon: 121.0292, lat: 14.5215 }, { lon: 121.0296, lat: 14.5195 });
    expect(r!.distanceKm).toBeCloseTo(0.64, 5);
    expect(r!.minutes).toBeCloseTo(1.5, 5);
    expect(r!.coordinates).toHaveLength(2);
    expect(r!.steps[0]!.name).toBe('East Service Road');
    expect(r!.snapped.start).toEqual({ lon: 121.0282, lat: 14.5209, distanceM: 123 });
    expect(r!.snapped.end).toEqual({ lon: 121.0291, lat: 14.5193, distanceM: 60 });
  });

  it('returns null when OSRM says there is no route, and throws on other errors', async () => {
    const none = async () => ({ ok: true, status: 200, json: async () => ({ code: 'NoRoute' }) });
    expect(await new OsrmClient('http://x', 1000, none).route({ lon: 1, lat: 1 }, { lon: 2, lat: 2 })).toBeNull();
    const bad = async () => ({ ok: false, status: 400, json: async () => ({ code: 'InvalidQuery' }) });
    await expect(new OsrmClient('http://x', 1000, bad).route({ lon: 1, lat: 1 }, { lon: 2, lat: 2 })).rejects.toBeInstanceOf(OsrmError);
  });
});

describe('OsrmClient retries (a busy or rate-limiting server must not be hammered)', () => {
  const okBody = { code: 'Ok', durations: [[60]], distances: [[1000]] };
  /** Answers with the given statuses in order, then 200. */
  function sequence(statuses: number[], headers: Record<string, string> = {}) {
    let i = 0;
    const calls: number[] = [];
    const fetchFn = async () => {
      const status = statuses[i++] ?? 200;
      calls.push(status);
      return {
        ok: status < 400,
        status,
        headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
        json: async () => (status < 400 ? okBody : { code: 'Error' }),
      };
    };
    return { fetchFn, calls };
  }
  const delays = () => {
    const slept: number[] = [];
    return { slept, sleep: async (ms: number) => void slept.push(ms) };
  };

  it('retries 503 with growing waits and then succeeds', async () => {
    const { fetchFn, calls } = sequence([503, 503]);
    const { slept, sleep } = delays();
    const t = await new OsrmClient('http://x', 1000, fetchFn, 100, 'driving', { sleep, baseDelayMs: 100 }).table([pt(0)], [pt(1)]);
    expect(t.minutes).toEqual([[1]]);
    expect(calls).toEqual([503, 503, 200]);
    expect(slept).toHaveLength(2);
    expect(slept[1]!).toBeGreaterThan(slept[0]!); // exponential: ~100 then ~200 ms (jitter +-25%)
    expect(slept[0]!).toBeGreaterThanOrEqual(75);
    expect(slept[0]!).toBeLessThanOrEqual(125);
  });

  it('gives up after the retry limit and reports the 503', async () => {
    const { fetchFn, calls } = sequence([503, 503, 503, 503, 503, 503]);
    const { slept, sleep } = delays();
    await expect(new OsrmClient('http://x', 1000, fetchFn, 100, 'driving', { sleep, retries: 2 }).table([pt(0)], [pt(1)])).rejects.toThrow(/503/);
    expect(calls).toHaveLength(3); // the first try and two retries, no more
    expect(slept).toHaveLength(2);
  });

  it('waits as long as the server says (Retry-After), instead of its own schedule', async () => {
    const { fetchFn } = sequence([429], { 'retry-after': '7' });
    const { slept, sleep } = delays();
    await new OsrmClient('http://x', 1000, fetchFn, 100, 'driving', { sleep }).table([pt(0)], [pt(1)]);
    expect(slept).toEqual([7000]);
  });

  it('does not retry a real error (bad request) or a no-route answer', async () => {
    const { fetchFn, calls } = sequence([400]);
    const { slept, sleep } = delays();
    await expect(new OsrmClient('http://x', 1000, fetchFn, 100, 'driving', { sleep }).table([pt(0)], [pt(1)])).rejects.toBeInstanceOf(OsrmError);
    expect(calls).toEqual([400]);
    expect(slept).toEqual([]);
  });

  it('retries a network failure, then succeeds', async () => {
    let n = 0;
    const flaky = async () => {
      if (n++ < 2) throw new Error('connect ECONNRESET');
      return { ok: true, status: 200, json: async () => okBody };
    };
    const { slept, sleep } = delays();
    const t = await new OsrmClient('http://x', 1000, flaky, 100, 'driving', { sleep }).table([pt(0)], [pt(1)]);
    expect(t.minutes).toEqual([[1]]);
    expect(slept).toHaveLength(2);
  });

  it('retries route lookups the same way', async () => {
    const routeBody = {
      code: 'Ok',
      waypoints: [{ location: [1, 1], distance: 5 }, { location: [2, 2], distance: 6 }],
      routes: [{ distance: 1000, duration: 120, geometry: { coordinates: [[1, 1], [2, 2]] }, legs: [{ steps: [] }] }],
    };
    let n = 0;
    const fetchFn = async () => (n++ === 0 ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, status: 200, json: async () => routeBody });
    const { slept, sleep } = delays();
    const r = await new OsrmClient('http://x', 1000, fetchFn, 100, 'driving', { sleep }).route({ lon: 1, lat: 1 }, { lon: 2, lat: 2 });
    expect(r!.minutes).toBe(2);
    expect(slept).toHaveLength(1);
  });
});

describe('OsrmClient.nearest (snap a point to the road)', () => {
  const reply = (body: unknown, status = 200) => async () => ({ ok: status < 400, status, json: async () => body })

  it('returns the road point, how far it moved, and the road name', async () => {
    const calls: string[] = [];
    const fetchFn = async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ code: 'Ok', waypoints: [{ location: [122.0005, 13.9046], distance: 514.8, name: 'Maharlika Highway' }] }) };
    };
    const r = await new OsrmClient('http://osrm:5000/', 1000, fetchFn).nearest({ lon: 122.0, lat: 13.9 });
    expect(calls[0]).toBe('http://osrm:5000/nearest/v1/driving/122.000000,13.900000?number=1');
    expect(r).toEqual({ lon: 122.0005, lat: 13.9046, distanceM: 515, road: 'Maharlika Highway' });
  });

  it('gives no name for an unnamed road, and null when OSRM has no road near', async () => {
    const unnamed = reply({ code: 'Ok', waypoints: [{ location: [1, 2], distance: 10, name: '' }] });
    expect((await new OsrmClient('http://x', 1000, unnamed).nearest({ lon: 1, lat: 2 }))!.road).toBeNull();
    const none = reply({ code: 'NoSegment' }, 400);
    expect(await new OsrmClient('http://x', 1000, none).nearest({ lon: 1, lat: 2 })).toBeNull();
  });

  it('throws on any other OSRM error', async () => {
    await expect(new OsrmClient('http://x', 1000, reply({ code: 'InvalidQuery' }, 400)).nearest({ lon: 1, lat: 2 })).rejects.toBeInstanceOf(OsrmError);
  });
});
