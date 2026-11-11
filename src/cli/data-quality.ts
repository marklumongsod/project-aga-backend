/**
 * Data-quality report: npm run data:quality
 *
 * Whenever data is dropped or filled in, this checks whether it can be saved with a statistic instead:
 *   1. Assessment centers excluded from the analysis. Those excluded on purpose (not listed by the TESDA API, hidden,
 *      foreign, closed) stay out.
 *      The rest (coordinates disputed, or no city/province link) are tested: do the coordinates fall in the province the
 *      record names, and do they sit with the other centers of their city (median + 3 x MAD)? Eligible ones can be
 *      recovered with --apply. Every change is logged in center_recovery_log, and --revert puts it all back.
 *   2. Candidates (upcoming TESDA graduates) that the API places only in a province, so they are split over its towns.
 *      Shows how much of the demand that is, and lists the provinces where most of it is split (town figures there
 *      are mostly estimates).
 *
 *   npm run data:quality                 report only (changes nothing)
 *   npm run data:quality -- --apply      recover the centers that pass, then re-run `npm run travel:build` and `npm run simulate`
 *   npm run data:quality -- --revert     undo --apply
 */
import { DataSource } from 'typeorm';
import { haversineKm } from '../common/geo/haversine';
import { median } from '../common/robust-stats';
import { typeormOptions } from '../database/data-source';
import { CityContext, decideRecovery, ExcludedCenter, normalizeName } from '../database/center-recovery';
import { DemandService } from '../simulation/demand.service';

interface Row {
  id: number;
  name: string;
  lat: number;
  lon: number;
  coord_status: string;
  is_foreign: boolean;
  is_hidden: boolean;
  is_closed: boolean;
  /** false = not in the TESDA API's list, which the analysis uses */
  tesda_listed: boolean | null;
  city_id: number | null;
  province_psgc: string | null;
  region_psgc: string | null;
  island_id: number | null;
  source_city_name: string | null;
  source_province_name: string | null;
  in_province_psgc: string | null;
  in_province: string | null;
  in_region_psgc: string | null;
}

const fmt = (n: number) => n.toLocaleString('en-PH');
const line = (c = '-') => c.repeat(78);

async function main() {
  const apply = process.argv.includes('--apply');
  const revert = process.argv.includes('--revert');
  const ds = await new DataSource(typeormOptions()).initialize();
  try {
    const [{ ok }] = await ds.query(`SELECT to_regclass('public.center_recovery_log') IS NOT NULL AS ok`);
    if (!ok) throw new Error('center_recovery_log is missing: run `npm run db:migrate` first');
    if (revert) return await revertAll(ds);

    const [{ analysed, total }] = await ds.query(
      `SELECT count(*) FILTER (WHERE include_in_analysis)::int AS analysed, count(*)::int AS total FROM assessment_centers`,
    );
    console.log(`\nAssessment centers: ${fmt(total)} in the data, ${fmt(analysed)} in the analysis, ${fmt(total - analysed)} excluded.\n${line('=')}`);

    const excluded: Row[] = await ds.query(
      `SELECT a.id, a.name, a.lat, a.lon, a.coord_status, a.is_foreign, a.is_hidden, a.is_closed, a.tesda_listed, a.city_id, a.province_psgc,
              a.region_psgc, a.island_id, a.source_city_name, a.source_province_name,
              prov.psgc AS in_province_psgc, prov.name AS in_province, prov.region_psgc AS in_region_psgc
         FROM assessment_centers a
         LEFT JOIN LATERAL (SELECT p.psgc, p.name, p.region_psgc FROM provinces p WHERE ST_Intersects(p.geom, a.location) LIMIT 1) prov ON true
        WHERE NOT a.include_in_analysis AND NOT EXISTS (SELECT 1 FROM center_recovery_log l WHERE l.center_id = a.id)`,
    );
    const onPurpose = (r: Row) => r.tesda_listed === false || r.is_foreign || r.is_hidden || r.is_closed;
    const deliberate = excluded.filter(onPurpose);
    const testable = excluded.filter((r) => !onPurpose(r));
    const by = (f: (r: Row) => string) => {
      const m = new Map<string, number>();
      for (const r of deliberate) m.set(f(r), (m.get(f(r)) ?? 0) + 1);
      return [...m].map(([k, n]) => `${fmt(n)} ${k}`).join(', ');
    };
    console.log(`Excluded on purpose (stay out): ${by((r) => (r.tesda_listed === false ? 'not listed by the TESDA API' : r.is_foreign ? 'foreign' : r.is_closed ? 'closed' : 'hidden by TESDA'))}`);
    console.log(`Excluded for data problems (tested below): ${fmt(testable.length)}\n`);

    const cities: Array<{ id: number; key: string; name: string; province_psgc: string; island_id: number | null; lon: number; lat: number }> =
      await ds.query(`SELECT id, key, name, province_psgc, island_id, ST_X(centroid) AS lon, ST_Y(centroid) AS lat FROM cities`);
    const peerRows: Array<{ city_id: number; km: number }> = await ds.query(
      `SELECT a.city_id, ST_Distance(a.location::geography, ci.centroid::geography) / 1000 AS km
         FROM assessment_centers a JOIN cities ci ON ci.id = a.city_id WHERE a.include_in_analysis`,
    );
    const peers = new Map<number, number[]>();
    for (const p of peerRows) peers.set(p.city_id, [...(peers.get(p.city_id) ?? []), p.km]);

    // Excluded centers whose source city has no row in the cities table are judged as a group (e.g. Bacolod City).
    const matchOf = (r: Row) =>
      cities.find((c) => c.province_psgc === r.in_province_psgc && normalizeName(c.name) === normalizeName(r.source_city_name)) ?? null;
    const groups = new Map<string, Row[]>();
    for (const r of testable) {
      if (!matchOf(r)) {
        const k = `${normalizeName(r.source_city_name)}|${r.in_province_psgc}`;
        groups.set(k, [...(groups.get(k) ?? []), r]);
      }
    }

    interface Verdict {
      row: Row;
      recover: boolean;
      method?: string;
      evidence?: Record<string, unknown>;
      reason?: string;
      cityId: number | null;
      islandId: number | null;
    }
    const verdicts: Verdict[] = [];
    for (const r of testable) {
      const city = matchOf(r);
      const member = groups.get(`${normalizeName(r.source_city_name)}|${r.in_province_psgc}`) ?? [];
      const mlat = median(member.map((m) => m.lat));
      const mlon = median(member.map((m) => m.lon));
      const ex: ExcludedCenter = {
        id: r.id,
        lat: r.lat,
        lon: r.lon,
        sourceCityName: r.source_city_name,
        sourceProvinceName: r.source_province_name,
        insideProvince: r.in_province,
      };
      const ctx: CityContext = {
        matchedCity: city ? { id: city.id, name: city.name } : null,
        peerDistancesKm: city ? (peers.get(city.id) ?? []) : [],
        distanceToCityKm: city ? haversineKm(r.lat, r.lon, city.lat, city.lon) : null,
        clusterDistancesKm: city ? [] : member.map((m) => haversineKm(m.lat, m.lon, mlat, mlon)),
        distanceToClusterKm: city || !member.length ? null : haversineKm(r.lat, r.lon, mlat, mlon),
      };
      const d = decideRecovery(ex, ctx);
      let islandId = city?.island_id ?? null;
      if (d.recover && islandId === null && r.in_province_psgc) {
        const [n] = await ds.query(
          `SELECT island_id FROM cities WHERE province_psgc = $1 ORDER BY centroid <-> ST_SetSRID(ST_MakePoint($2, $3), 4326) LIMIT 1`,
          [r.in_province_psgc, r.lon, r.lat],
        );
        islandId = n?.island_id ?? null;
      }
      verdicts.push({ row: r, recover: d.recover, method: d.recover ? d.method : undefined, evidence: d.recover ? d.evidence : undefined, reason: d.recover ? undefined : d.reason, cityId: city?.id ?? null, islandId });
    }

    const saved = verdicts.filter((v) => v.recover);
    const kept = verdicts.filter((v) => !v.recover);
    console.log(`Can be saved: ${fmt(saved.length)}   Stay out: ${fmt(kept.length)}\n${line()}`);
    const group = (vs: Verdict[], key: (v: Verdict) => string) => {
      const m = new Map<string, Verdict[]>();
      for (const v of vs) m.set(key(v), [...(m.get(key(v)) ?? []), v]);
      return [...m];
    };
    for (const [k, vs] of group(saved, (v) => `${v.row.source_city_name ?? '?'}, ${v.row.in_province} [${v.row.coord_status}] via ${v.method}`))
      console.log(`  save  ${String(vs.length).padStart(3)}  ${k}\n          e.g. ${JSON.stringify(vs[0]!.evidence)}`);
    for (const [k, vs] of group(kept, (v) => `${v.row.source_city_name ?? '?'} [${v.row.coord_status}]: ${v.reason}`))
      console.log(`  keep  ${String(vs.length).padStart(3)}  ${k}`);

    // ---- candidates split from province-only graduates
    console.log(`\nCandidates (upcoming TESDA graduates)\n${line('=')}`);
    const groupsD = await new DemandService(ds).currentGroups();
    const allCandidates = groupsD.reduce((n, g) => n + g.count, 0);
    const splitTotal = groupsD.reduce((n, g) => n + g.estimated, 0);
    const pct = (n: number, of: number) => (of ? ((100 * n) / of).toFixed(1) : '0.0').padStart(5);
    console.log(`  ${'placed in a town by the TESDA API'.padEnd(44)} ${fmt(allCandidates - splitTotal).padStart(10)} candidates  ${pct(allCandidates - splitTotal, allCandidates)}%`);
    console.log(`  ${'province only, split over its towns'.padEnd(44)} ${fmt(splitTotal).padStart(10)} candidates  ${pct(splitTotal, allCandidates)}%`);
    const byProv = new Map<string, { all: number; split: number }>();
    for (const g of groupsD) {
      const p = byProv.get(g.provincePsgc) ?? { all: 0, split: 0 };
      p.all += g.count;
      p.split += g.estimated;
      byProv.set(g.provincePsgc, p);
    }
    const mostlySplit = [...byProv].filter(([, p]) => p.all > 0 && p.split / p.all > 0.5).sort((a, b) => b[1].split / b[1].all - a[1].split / a[1].all);
    console.log(
      mostlySplit.length
        ? `\n  Provinces where most candidates are split (their town figures are mostly estimates):\n${mostlySplit.map(([prov, p]) => `  ${prov}: ${pct(p.split, p.all)}% of ${fmt(p.all)}`).join('\n')}`
        : '\n  In every province, most candidates are placed in a town.',
    );

    if (apply) {
      await ds.transaction(async (m) => {
        for (const v of saved) {
          const r = v.row;
          const before = { include_in_analysis: false, coord_status: r.coord_status, city_id: r.city_id, province_psgc: r.province_psgc, region_psgc: r.region_psgc, island_id: r.island_id };
          const after = { include_in_analysis: true, coord_status: r.coord_status === 'disputed' ? 'recovered_disputed' : r.coord_status, city_id: v.cityId, province_psgc: r.in_province_psgc, region_psgc: r.in_region_psgc, island_id: v.islandId };
          await m.query(`INSERT INTO center_recovery_log (center_id, method, evidence, before, after) VALUES ($1, $2, $3, $4, $5)`, [r.id, v.method, JSON.stringify(v.evidence), JSON.stringify(before), JSON.stringify(after)]);
          await m.query(
            `UPDATE assessment_centers SET include_in_analysis = true, coord_status = $2, city_id = $3, province_psgc = $4, region_psgc = $5, island_id = $6 WHERE id = $1`,
            [r.id, after.coord_status, after.city_id, after.province_psgc, after.region_psgc, after.island_id],
          );
        }
      });
      console.log(`\nApplied: ${fmt(saved.length)} centers recovered (logged in center_recovery_log).\nNext: npm run travel:build && npm run simulate   (undo with: npm run data:quality -- --revert)`);
    } else if (saved.length) {
      console.log(`\nDry run: nothing changed. Re-run with --apply to recover the ${fmt(saved.length)} centers above.`);
    }
  } finally {
    await ds.destroy();
  }
}

async function revertAll(ds: DataSource) {
  const rows: Array<{ center_id: number; before: Record<string, unknown> }> = await ds.query(`SELECT center_id, before FROM center_recovery_log`);
  await ds.transaction(async (m) => {
    for (const r of rows) {
      const b = r.before;
      await m.query(
        `UPDATE assessment_centers SET include_in_analysis = $2, coord_status = $3, city_id = $4, province_psgc = $5, region_psgc = $6, island_id = $7 WHERE id = $1`,
        [r.center_id, b.include_in_analysis, b.coord_status, b.city_id, b.province_psgc, b.region_psgc, b.island_id],
      );
    }
    await m.query(`DELETE FROM center_recovery_log`);
  });
  console.log(`Reverted ${rows.length} centers to how they were. Next: npm run travel:build && npm run simulate`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
