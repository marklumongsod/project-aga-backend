/**
 * Local demo data for the capacity utilization view:
 *   - 20 slots per program per center per month (the agreed demo rule)
 *   - candidates per city, split over the center qualifications, for the selected quarter
 *
 * If the database already has real TESDA upcoming graduates, only the slots are generated. Otherwise demo candidates
 * are added too. Demo rows are marked `source = 'demo'` and are safe to delete/recreate.
 *
 *   npm run demo:utilization -- --quarter=2026-Q4
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { currentQuarter, parseQuarter, quarterMonths } from '../common/quarter';
import { nowEpoch } from '../database/epoch';
import { typeormOptions } from '../database/data-source';
import { DemandService } from '../simulation/demand.service';
import { apportion } from '../simulation/demand-split';
import { qualificationKey } from '../simulation/qualification-need';

const SLOTS_PER_PROGRAM_MONTH = 20;
/** Candidate count per city when there is no real TESDA graduate data to use. */
const DEMO_CANDIDATES_PER_CITY = 600;
/** Names as the TESDA API writes them. Qualifications are identified by name; there is no T2MIS QualId. */
const DEMO_QUALS = ['Cookery II', 'Bread and Pastry Production II', 'Driving II'];
const SHARES = [0.5, 0.3, 0.2];

function quarterArg(): string | undefined {
  const arg = process.argv.find((a) => a.startsWith('--quarter='));
  return arg?.slice('--quarter='.length);
}

async function main() {
  const ds = await new DataSource(typeormOptions()).initialize();
  try {
    const quarter = quarterArg() ? parseQuarter(quarterArg()!) : currentQuarter();
    if (!quarter) throw new Error('quarter must look like 2026-Q4');
    const months = quarterMonths(quarter);
    const now = nowEpoch();

    await ds.transaction(async (m) => {
      // Remove previous demo rows for this quarter; never touch TESDA rows.
      await m.query(`DELETE FROM upcoming_graduates WHERE source = 'demo' AND finish_month >= $1 AND finish_month < $2`, [
        quarter.start,
        quarter.end,
      ]);
      await m.query(`DELETE FROM center_qualification_slots WHERE source = 'demo' AND month_start >= $1 AND month_start < $2`, [
        quarter.start,
        quarter.end,
      ]);

      const [{ centers }]: Array<{ centers: number }> = await m.query(
        `SELECT count(*)::int AS centers FROM assessment_centers WHERE include_in_analysis`,
      );
      if (!centers) throw new Error('No centers in the analysis; run npm run tesda:sync (needs TESDA_API_KEY) or restore a demo dump first');

      // A fresh demo database may not have the TESDA center qualification list yet.
      const [{ n }]: Array<{ n: number }> = await m.query(`SELECT count(*)::int AS n FROM center_qualifications`);
      if (n === 0) {
        for (const name of DEMO_QUALS) {
          await m.query(
            `INSERT INTO center_qualifications (center_id, qualification)
             SELECT c.id, $1 FROM assessment_centers c WHERE c.include_in_analysis
             ON CONFLICT DO NOTHING`,
            [name],
          );
        }
      }

      const [{ real }]: Array<{ real: number }> = await m.query(
        `SELECT count(*)::int AS real FROM upcoming_graduates WHERE source <> 'demo'`,
      );
      const candidates = real
        ? await new DemandService(ds).currentGroups()
        : await syntheticCandidates(m, months[0]!);

      const cityRows = real
        ? []
        : (candidates as Array<{ province_psgc: string; city_id: number; qualification: string; graduates: number }>);
      const batch = 2000;
      for (let i = 0; i < cityRows.length; i += batch) {
        const part = cityRows.slice(i, i + batch);
        await m.query(
          `INSERT INTO upcoming_graduates (province_psgc, city_id, qualification, finish_month, graduates, source)
           SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::bigint[], $5::int[], $6::text[])`,
          [
            part.map((r) => r.province_psgc),
            part.map((r) => r.city_id),
            part.map((r) => r.qualification),
            part.map(() => months[0]!),
            part.map((r) => r.graduates),
            part.map(() => 'demo'),
          ],
        );
      }

      // A few province-only graduates per province, so the demo also exercises the estimated-candidate split.
      let provinceOnly = 0;
      if (!real) {
        const provinces: Array<{ psgc: string }> = await m.query(`SELECT psgc FROM provinces ORDER BY psgc`);
        provinceOnly = provinces.length * 100;
        await m.query(
          `INSERT INTO upcoming_graduates (province_psgc, city_id, qualification, finish_month, graduates, source)
           SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::bigint[], $5::int[], $6::text[])`,
          [
            provinces.map((p) => p.psgc),
            provinces.map(() => null),
            provinces.map(() => DEMO_QUALS[0]!),
            provinces.map(() => months[0]!),
            provinces.map(() => 100),
            provinces.map(() => 'demo'),
          ],
        );
      }

      // 20 slots for every center × qualification × month in the quarter.
      const offers: Array<{ center_id: number; qualification: string }> = await m.query(
        `SELECT cq.center_id, cq.qualification
           FROM center_qualifications cq JOIN assessment_centers c ON c.id = cq.center_id
          WHERE c.include_in_analysis`,
      );
      const slots: Array<{ center: number; key: string; name: string; month: number }> = [];
      for (const o of offers) {
        for (const month of months) {
          slots.push({
            center: o.center_id,
            key: qualificationKey(o.qualification),
            name: o.qualification,
            month,
          });
        }
      }
      for (let i = 0; i < slots.length; i += batch) {
        const part = slots.slice(i, i + batch);
        await m.query(
          `INSERT INTO center_qualification_slots
             (center_id, qualification_key, qualification, month_start, slots, source, as_of)
           SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::bigint[], $5::int[], $6::text[], $7::bigint[])`,
          [
            part.map((r) => r.center),
            part.map((r) => r.key),
            part.map((r) => r.name),
            part.map((r) => r.month),
            part.map(() => SLOTS_PER_PROGRAM_MONTH),
            part.map(() => 'demo'),
            part.map(() => now),
          ],
        );
      }

      const sample = offers[0]?.qualification ?? DEMO_QUALS[0]!;
      console.log(`demo quarter ${quarter.label}`);
      console.log(`  candidates: ${real ? 'real TESDA upcoming graduates (unchanged)' : `${cityRows.length} city-qualification rows, ${cityRows.reduce((n, r) => n + r.graduates, 0) + provinceOnly} candidates`}`);
      console.log(`  centers: ${new Set(offers.map((o) => o.center_id)).size} with qualifications, ${offers.length} center-qualification rows`);
      console.log(`  slots: ${slots.length} monthly rows, ${SLOTS_PER_PROGRAM_MONTH} slots each`);
      console.log(`  sample: /dashboard/overview?level=NATIONAL&qualification=${encodeURIComponent(qualificationKey(sample))}&quarter=${quarter.label}`);
      console.log(`  center: /centers/<id>/utilization?quarter=${quarter.label}`);
    });
  } finally {
    await ds.destroy();
  }
}

/** Demo candidate rows: a fixed count per city, split over the first few real center qualifications. */
async function syntheticCandidates(
  m: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  month: number,
): Promise<Array<{ province_psgc: string; city_id: number; qualification: string; graduates: number }>> {
  const quals: Array<{ qualification: string }> = (await m.query(
    `SELECT cq.qualification, count(*)::int AS centers
       FROM center_qualifications cq JOIN assessment_centers c ON c.id = cq.center_id
      WHERE c.include_in_analysis
      GROUP BY cq.qualification
      ORDER BY count(*) DESC, cq.qualification
      LIMIT 3`,
  )) as Array<{ qualification: string }>;
  const names = quals.length ? quals.map((q) => q.qualification) : DEMO_QUALS;
  const cities: Array<{ id: number; province_psgc: string }> = (await m.query(
    `SELECT id, province_psgc FROM cities ORDER BY key`,
  )) as Array<{ id: number; province_psgc: string }>;
  const out: Array<{ province_psgc: string; city_id: number; qualification: string; graduates: number }> = [];
  for (const city of cities) {
    const shares = apportion(new Map(names.map((name, i) => [name, DEMO_CANDIDATES_PER_CITY * SHARES[i]!])));
    for (const name of names) {
      const count = shares.get(name) ?? 0;
      if (count > 0) out.push({ province_psgc: city.province_psgc, city_id: city.id, qualification: name, graduates: count });
    }
  }
  void month;
  return out;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
