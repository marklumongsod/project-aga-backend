/**
 * Load the committed forecast snapshot into Postgres.
 *
 *   npm run forecast:seed                 # fresh database
 *   npm run forecast:seed -- --force      # replace existing forecast tables
 *
 * The snapshot is a point-in-time 2026-10 run. It needs the core backend data (centers, provinces,
 * qualifications) because forecast_values.center_id is a foreign key. It does not need the raw T2MIS
 * CSVs or the LightGBM model artifact.
 */
import 'reflect-metadata';
import { existsSync, readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { DataSource } from 'typeorm';
import { typeormOptions } from '../database/data-source';

const DEFAULT_FILE = 'seed/forecasts/2026-10/forecast_tables.sql.gz';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function monthLabel(epochSeconds: number): string {
  const d = new Date(Number(epochSeconds) * 1000 + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function main() {
  const file = arg('file') ?? DEFAULT_FILE;
  if (!existsSync(file)) throw new Error(`Seed file not found: ${file}`);
  const raw = readFileSync(file);
  const sql = file.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');

  const ds = await new DataSource(typeormOptions()).initialize();
  try {
    let existing = 0;
    try {
      const [row] = await ds.query(`SELECT count(*)::int AS count FROM public.forecast_runs`);
      existing = Number(row.count);
    } catch {
      throw new Error('Forecast tables are missing. Run npm run db:migrate first.');
    }
    if (existing > 0 && !flag('force')) {
      throw new Error(
        `forecast_runs already has ${existing} run(s). Re-run with --force to replace the forecast tables.`,
      );
    }

    await ds.transaction(async (manager) => {
      await manager.query(sql);
    });

    const [run] = await ds.query(
      `SELECT forecast_month, model_version, row_count FROM public.forecast_runs ORDER BY imported_at DESC LIMIT 1`,
    );
    const [{ values }] = await ds.query(`SELECT count(*)::int AS values FROM public.forecast_values`);
    const [{ places }] = await ds.query(`SELECT count(*)::int AS places FROM public.forecast_places`);
    console.log('forecast seed loaded');
    console.log(`  forecast month: ${monthLabel(run.forecast_month)}`);
    console.log(`  model version:  ${run.model_version}`);
    console.log(`  source rows:    ${run.row_count}`);
    console.log(`  stored values:  ${values}`);
    console.log(`  places:         ${places}`);
  } finally {
    await ds.destroy();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
