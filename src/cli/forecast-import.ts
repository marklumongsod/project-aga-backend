/**
 * Import a monthly forecast file into Postgres.
 *
 *   npm run forecast:import -- --file=forecast_out/forecasts_2026-10.json \
 *     --meta=forecast_out/forecast_meta_2026-10.json --replace
 *
 * The default place mapping is docs/forecast/forecast_places.csv. The Python job that produced the JSON is
 * outside the API; this command only reads aggregate counts and never touches raw learner data.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { typeormOptions } from '../database/data-source';
import { ForecastImportService } from '../forecast/forecast-import.service';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const file = arg('file');
  if (!file) throw new Error('Give --file=forecasts_YYYY-MM.json');
  const places = arg('places') ?? 'docs/forecast/forecast_places.csv';
  const sampleRate = arg('sample-rate') ? Number(arg('sample-rate')) : undefined;

  const ds = await new DataSource(typeormOptions()).initialize();
  try {
    const report = await new ForecastImportService(ds).import({
      file,
      places,
      meta: arg('meta'),
      modelVersion: arg('model-version'),
      sampleRate,
      replace: flag('replace'),
      dryRun: flag('dry-run'),
      persistPlaces: !flag('no-places'),
    });

    console.log(`forecast ${report.forecastMonth} (${report.modelVersion})`);
    console.log(`  source rows: ${report.sourceRows}`);
    console.log(`  stored values: ${report.values}`);
    console.log(
      `  places: ${report.places.national} national, ${report.places.region} regions, ` +
        `${report.places.province} provinces, ${report.places.center} centers`,
    );
    console.log(
      `  mapped source rows: ${report.mappedSourceRows.national} national, ` +
        `${report.mappedSourceRows.region} regions, ${report.mappedSourceRows.province} provinces, ` +
        `${report.mappedSourceRows.center} centers`,
    );
    console.log(
      `  excluded source rows: ${report.excludedSourceRows.national} national, ` +
        `${report.excludedSourceRows.region} regions, ${report.excludedSourceRows.province} provinces, ` +
        `${report.excludedSourceRows.center} centers`,
    );
    if (report.unmatchedCenters.length) {
      console.log(`  centers without a backend match: ${report.unmatchedCenters.join(', ')}`);
    }
    console.log('  national forecast:');
    for (const r of report.national) console.log(`    ${r.targetMonth} (h${r.horizon})  ${r.candidates}`);
    console.log(report.persisted ? `  stored run ${report.runId}` : '  dry run: nothing written');
  } finally {
    await ds.destroy();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
