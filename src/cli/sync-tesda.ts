/**
 * Pull assessment centers, their qualifications and graduates per school from the TESDA API once: npm run tesda:sync
 * Skipped when TESDA has not recalculated since the last sync; `npm run tesda:sync -- --force` pulls anyway.
 * Then: npm run data:quality -- --apply (place centers at sea), npm run travel:build (osrm only), npm run simulate.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { TesdaSyncService } from '../tesda/tesda-sync.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  try {
    const stats = await app.get(TesdaSyncService).sync('cli', process.argv.includes('--force'));
    console.log(JSON.stringify(stats, null, 2));
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(`TESDA sync failed: ${(e as Error).message}. The centers in the database were not changed.`);
  process.exit(1);
});
