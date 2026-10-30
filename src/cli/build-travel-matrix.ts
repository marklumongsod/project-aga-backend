/**
 * Build the road + ferry travel-time matrix from an OSRM server: npm run travel:build
 * Needs the OSRM server up (docker compose --profile routing up -d osrm; see scripts/osrm-prepare.sh).
 * Then set TRAVEL_MODEL=osrm and re-run the simulation.
 */
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { OsrmClient } from '../simulation/travel/osrm.client';
import { TravelMatrixService } from '../simulation/travel/travel-matrix.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  try {
    const url = app.get(ConfigService).get<string>('OSRM_URL') || 'http://localhost:5001';
    const client = new OsrmClient(url, 30_000);
    // Fail fast with a clear message if the server is not reachable or has no Philippines map.
    const probe = await client.table([{ lon: 123.07, lat: 10.67 }], [{ lon: 122.95, lat: 10.6 }]).catch((e: Error) => {
      throw new Error(`Cannot reach OSRM at ${url}: ${e.message}`);
    });
    if (probe.minutes[0]?.[0] == null) throw new Error(`OSRM at ${url} has no route in the Philippines: is the map loaded?`);

    let last = 0;
    const started = Date.now();
    const r = await app.get(TravelMatrixService).build(client, (done, total) => {
      const pct = Math.floor((done / total) * 100);
      if (pct >= last + 10) {
        last = pct;
        console.log(`  ${pct}% (${done}/${total} cities, ${Math.round((Date.now() - started) / 1000)} s)`);
      }
    });
    console.log(
      `Done: ${r.routed} routed pairs of ${r.pairs} within the km limit (${r.unrouted} without a route fall back to the estimate), ` +
        `${r.cities} cities x ${r.centers} centers.`,
    );
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
