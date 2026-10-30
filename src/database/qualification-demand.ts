import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';

const FILE = join(__dirname, '..', '..', 'database', 'seed-data', 'province_qualifications.json');

interface Row {
  provincePsgc: string;
  qualificationId: number;
  qualification: string;
  graduates: number;
}

/**
 * Replace `province_qualification_graduates` with the rows of database/seed-data/province_qualifications.json
 * (built by `python3 etl/build_qualification_demand.py`). Rows for a province that isn't in `provinces` are skipped.
 * Returns how many rows were loaded, or null when the file doesn't exist.
 */
export async function loadQualificationDemand(ds: DataSource): Promise<number | null> {
  if (!existsSync(FILE)) return null;
  const rows = JSON.parse(readFileSync(FILE, 'utf8')) as Row[];
  let loaded = 0;
  await ds.transaction(async (m) => {
    await m.query(`DELETE FROM province_qualification_graduates`);
    for (let i = 0; i < rows.length; i += 1000) {
      const part = rows.slice(i, i + 1000);
      const res: Array<{ n: number }> = await m.query(
        `WITH ins AS (
           INSERT INTO province_qualification_graduates (province_psgc, qualification_id, qualification, graduates)
           SELECT u.p, u.q, u.t, u.g
             FROM unnest($1::text[], $2::int[], $3::text[], $4::int[]) AS u(p, q, t, g)
             JOIN provinces pr ON pr.psgc = u.p
           ON CONFLICT DO NOTHING
           RETURNING 1)
         SELECT count(*)::int AS n FROM ins`,
        [part.map((r) => r.provincePsgc), part.map((r) => r.qualificationId), part.map((r) => r.qualification), part.map((r) => r.graduates)],
      );
      loaded += res[0]!.n;
    }
  });
  return loaded;
}
