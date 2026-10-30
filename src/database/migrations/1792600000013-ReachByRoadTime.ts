import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reach is decided by road travel time alone: the 50 km straight-line cap is gone, so a run no longer records a km
 * limit. The travel matrix must be rebuilt for the wider search radius (`npm run travel:build`), then `npm run simulate`.
 */
export class ReachByRoadTime1792600000013 implements MigrationInterface {
  name = 'ReachByRoadTime1792600000013';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "simulation_runs" DROP COLUMN "limit_km"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "simulation_runs" ADD "limit_km" integer NOT NULL DEFAULT 50`);
  }
}
