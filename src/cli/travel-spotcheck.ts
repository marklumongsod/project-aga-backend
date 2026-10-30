/**
 * QA: spot-check our travel times against Google Maps.
 *
 *   npm run qa:travel                       write qa-travel-spotcheck.csv: 10 cities, our minutes to their nearest center,
 *                                           and a Google Maps link for each trip
 *   npm run qa:travel -- --check file.csv   read the google_minutes column you filled in and report the ±20% result
 *
 * Google Maps can't be queried from here (no API key, and its terms don't allow bulk scraping), so the Google time is
 * read off the link by hand. Open each link, pick a typical weekday time, and type the minutes into the CSV.
 * The cities are fixed and spread across regions and island groups, so reruns compare like with like.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { DataSource } from 'typeorm';
import { typeormOptions } from '../database/data-source';

const TOLERANCE = 0.2;
const FILE = 'qa-travel-spotcheck.csv';

/**
 * 10 trips, picked by a fixed rule so reruns compare like with like: each city's fastest routed center, bucketed by trip
 * length (short trips make ±20% meaningless, so most are 20-90 minutes), at most one city per province, and within a
 * bucket the cities with the lowest md5(key) (a stable pseudo-random choice). Only cities that have candidates.
 */
const BUCKETS: Array<[from: number, to: number, take: number]> = [
  [10, 30, 2],
  [30, 60, 4],
  [60, 90, 4],
];

const link = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  `https://www.google.com/maps/dir/?api=1&origin=${a.lat},${a.lon}&destination=${b.lat},${b.lon}&travelmode=driving`;

const csv = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

async function generate(ds: DataSource) {
  const rows: string[][] = [];
  const used = new Set<string>();
  for (const [from, to, take] of BUCKETS) {
    const picks: Array<{
      city: string;
      province: string;
      province_psgc: string;
      minutes: number;
      road_km: number | null;
      center: string;
      clat: number;
      clon: number;
      lat: number;
      lon: number;
    }> = await ds.query(
      `SELECT DISTINCT ON (ci.province_psgc) ci.name AS city, p.name AS province, ci.province_psgc, n.minutes, n.road_km,
              a.name AS center, a.lat AS clat, a.lon AS clon, ST_Y(ci.centroid) AS lat, ST_X(ci.centroid) AS lon
         FROM cities ci
         JOIN provinces p ON p.psgc = ci.province_psgc
         JOIN LATERAL (SELECT t.center_id, t.minutes, t.road_km FROM travel_times t JOIN assessment_centers c ON c.id = t.center_id
                        WHERE t.city_key = ci.key AND c.include_in_analysis ORDER BY t.minutes LIMIT 1) n ON true
         JOIN assessment_centers a ON a.id = n.center_id
        WHERE n.minutes >= $1 AND n.minutes < $2 AND ci.province_psgc <> ALL($3::text[])
          AND EXISTS (SELECT 1 FROM area_utilization u WHERE u.area_key = ci.key AND u.level = 'CITY' AND u.candidates > 0)
        ORDER BY ci.province_psgc, md5(ci.key)`,
      [from, to, [...used]],
    );
    picks.sort((x, y) => (x.city + x.province > y.city + y.province ? 1 : -1));
    for (const c of picks.slice(0, take)) {
      used.add(c.province_psgc);
      rows.push([
        c.city,
        c.province,
        c.center,
        String(Math.round(c.minutes * 10) / 10),
        c.road_km == null ? '' : String(Math.round(c.road_km * 10) / 10),
        link(c, { lat: c.clat, lon: c.clon }),
        '', // google_minutes: fill in by hand
      ]);
    }
  }
  const head = ['city', 'province', 'nearest_center', 'our_minutes', 'our_road_km', 'google_maps_link', 'google_minutes'];
  writeFileSync(FILE, [head, ...rows].map((r) => r.map(csv).join(',')).join('\n') + '\n');
  console.log(`Wrote ${FILE}: ${rows.length} trips. Fill in google_minutes, then: npm run qa:travel -- --check ${FILE}`);
}

function check(file: string) {
  const lines = readFileSync(file, 'utf8').trim().split('\n').slice(1);
  let done = 0;
  let pass = 0;
  for (const line of lines) {
    const f = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"'));
    const [city, , center, ours, , , google] = f;
    const g = Number(google);
    if (!google || !Number.isFinite(g) || g <= 0) {
      console.log(`  --   ${city}: no Google time yet`);
      continue;
    }
    done++;
    const diff = (Number(ours) - g) / g;
    const ok = Math.abs(diff) <= TOLERANCE;
    if (ok) pass++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${city} -> ${center}: ours ${ours} min, Google ${g} min (${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(0)}%)`);
  }
  console.log(`\n${pass} of ${done} within ±${TOLERANCE * 100}%${done < lines.length ? ` (${lines.length - done} not filled in)` : ''}`);
  if (done < lines.length || pass < done) process.exitCode = 1;
}

async function main() {
  const i = process.argv.indexOf('--check');
  if (i >= 0) return check(process.argv[i + 1] ?? FILE);
  const ds = await new DataSource(typeormOptions()).initialize();
  try {
    await generate(ds);
  } finally {
    await ds.destroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
