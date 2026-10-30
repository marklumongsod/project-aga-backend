/** Load graduates per province and qualification: npm run data:qualifications (after `python3 etl/build_qualification_demand.py`). */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { typeormOptions } from '../database/data-source';
import { loadQualificationDemand } from '../database/qualification-demand';

async function main() {
  const ds = await new DataSource(typeormOptions()).initialize();
  try {
    const n = await loadQualificationDemand(ds);
    console.log(n === null ? 'database/seed-data/province_qualifications.json not found: run `python3 etl/build_qualification_demand.py <Graduates.xlsx>` first.' : `loaded ${n} province-qualification rows.`);
  } finally {
    await ds.destroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
