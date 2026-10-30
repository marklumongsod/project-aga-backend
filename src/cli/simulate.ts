/** Run the utilization simulation once from the command line: npm run simulate */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { SimulationService } from '../simulation/simulation.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  try {
    const runs = await app.get(SimulationService).runAll('cli');
    for (const r of runs) console.log(r.id, JSON.stringify(r.summary));
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
