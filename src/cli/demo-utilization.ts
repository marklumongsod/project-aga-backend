/**
 * Local demo data for the capacity utilization view:
 *   - 20 slots per program per center per month (the agreed demo rule)
 *   - per-city candidates split over three demo qualifications, in the selected quarter
 *
 * The data is marked `source = 'demo'` and is safe to delete/recreate. Production data comes from TESDA/NCR.
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
const DEMO_QUALS = [241, 231, 24]; // Cookery II, Bread and Pastry II, Driving II when present
const SHARES = [0.5, 0.3, 0.2];

function quarterArg(): string | undefined {
  const arg = process.argv.find((a) => a.startsWith('--quarter='));
  return arg?.slice('--quarter='.length);
}

interface DemoQualification {
  id: number;
  name: string;
}

async function demoQualifications(ds: DataSource): Promise<DemoQualification[]> {
  const rows: Array<{ id: number; title: string; level_id: number | null }> = await ds.query(
    `SELECT id, title, level_id FROM qualifications WHERE id = ANY($1::int[]) ORDER BY array_position($1::int[], id)`,
    [DEMO_QUALS],
  );
  const roman = ['', 'I', 'II', 'III', 'IV'];
  const found = rows.map((r) => ({
    id: r.id,
    name: `${r.title}${r.level_id ? ` ${roman[r.level_id] ?? ''}` : ''}`.trim(),
  }));
  if (found.length) return found;
  const fallback: Array<{ id: number; title: string; level_id: number | null }> = await ds.query(
    `SELECT id, title, level_id FROM qualifications ORDER BY id LIMIT 3`,
  );
  return fallback.map((r) => ({ id: r.id, name: `${r.title}${r.level_id ? ` ${roman[r.level_id] ?? ''}` : ''}`.trim() }));
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

      const quals = await demoQualifications(ds);
      if (!quals.length) throw new Error('No qualifications in the database; run npm run db:seed first');

      // A fresh demo database may not have the TESDA center qualification list yet.
      const [{ n }]: Array<{ n: number }> = await m.query(`SELECT count(*)::int AS n FROM center_qualifications`);
      if (n === 0) {
        for (const q of quals) {
          await m.query(
            `INSERT INTO center_qualifications (center_id, qualification, qualification_id)
             SELECT c.id, $1, $2 FROM assessment_centers c WHERE c.include_in_analysis
             ON CONFLICT DO NOTHING`,
            [q.name, q.id],
          );
        }
      }

      const cities: Array<{ id: number; key: string; province_psgc: string }> = await m.query(
        `SELECT id, key, province_psgc FROM cities ORDER BY key`,
      );
      const cityId = new Map(cities.map((c) => [c.key, c.id]));
      const groups = await new DemandService(ds).currentGroups();

      // Spread each city's candidates over the demo qualifications for the first month of the quarter. The quarter
      // filter sums the month, so the quarter demand equals the city's candidate count.
      const cityRows: Array<{ province: string; city: number; name: string; id: number; month: number; graduates: number }> = [];
      for (const g of groups) {
        const shares = apportion(new Map(quals.map((q, i) => [String(q.id), g.count * SHARES[i]!])));
        for (const q of quals) {
          const count = shares.get(String(q.id)) ?? 0;
          if (count <= 0) continue;
          cityRows.push({
            province: g.provincePsgc,
            city: cityId.get(g.key)!,
            name: q.name,
            id: q.id,
            month: months[0]!,
            graduates: count,
          });
        }
      }
      const batch = 2000;
      for (let i = 0; i < cityRows.length; i += batch) {
        const part = cityRows.slice(i, i + batch);
        await m.query(
          `INSERT INTO upcoming_graduates (province_psgc, city_id, qualification, qualification_id, finish_month, graduates, source)
           SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::int[], $5::bigint[], $6::int[], $7::text[])`,
          [
            part.map((r) => r.province),
            part.map((r) => r.city),
            part.map((r) => r.name),
            part.map((r) => r.id),
            part.map((r) => r.month),
            part.map((r) => r.graduates),
            part.map(() => 'demo'),
          ],
        );
      }

      // 20 slots for every center × qualification × month in the quarter.
      const offers: Array<{ center_id: number; qualification: string; qualification_id: number | null }> = await m.query(
        `SELECT cq.center_id, cq.qualification, cq.qualification_id
           FROM center_qualifications cq JOIN assessment_centers c ON c.id = cq.center_id
          WHERE c.include_in_analysis`,
      );
      const slots: Array<{ center: number; key: string; id: number | null; name: string; month: number }> = [];
      for (const o of offers) {
        for (const month of months) {
          slots.push({
            center: o.center_id,
            key: qualificationKey(o.qualification),
            id: o.qualification_id,
            name: o.qualification,
            month,
          });
        }
      }
      for (let i = 0; i < slots.length; i += batch) {
        const part = slots.slice(i, i + batch);
        await m.query(
          `INSERT INTO center_qualification_slots
             (center_id, qualification_key, qualification_id, qualification, month_start, slots, source, as_of)
           SELECT * FROM unnest($1::int[], $2::text[], $3::int[], $4::text[], $5::bigint[], $6::int[], $7::text[], $8::bigint[])`,
          [
            part.map((r) => r.center),
            part.map((r) => r.key),
            part.map((r) => r.id),
            part.map((r) => r.name),
            part.map((r) => r.month),
            part.map(() => SLOTS_PER_PROGRAM_MONTH),
            part.map(() => 'demo'),
            part.map(() => now),
          ],
        );
      }

      console.log(`demo quarter ${quarter.label}`);
      console.log(`  candidates: ${cityRows.length} city-qualification rows, ${groups.reduce((n, g) => n + g.count, 0)} candidates`);
      console.log(`  centers: ${new Set(offers.map((o) => o.center_id)).size} with qualifications, ${offers.length} center-qualification rows`);
      console.log(`  slots: ${slots.length} monthly rows, ${SLOTS_PER_PROGRAM_MONTH} slots each`);
      if (quals[0]) {
        console.log(`  sample: /dashboard/overview?level=NATIONAL&qualification=${encodeURIComponent(qualificationKey(quals[0].name))}&quarter=${quarter.label}`);
        console.log(`  center: /centers/<id>/utilization?quarter=${quarter.label}`);
      }
    });
  } finally {
    await ds.destroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
