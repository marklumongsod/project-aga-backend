import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The next-quarter ("Insights") forecast is gone, so a run no longer has a period. Deletes the NEXT_QUARTER runs
 * (their area and center results go with them), then drops `simulation_runs.period` and its enum type.
 * `school_graduates` and the TESDA graduates sync are kept for a real forecast later.
 */
export class DropNextQuarter1792600000012 implements MigrationInterface {
  name = 'DropNextQuarter1792600000012';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`DELETE FROM "simulation_runs" WHERE "period" = 'NEXT_QUARTER'`);
    await q.query(`DROP INDEX IF EXISTS "IDX_6b23d601993901a3b3652674e9"`);
    await q.query(`ALTER TABLE "simulation_runs" DROP COLUMN "period"`);
    await q.query(`DROP TYPE IF EXISTS "period"`);
    await q.query(`CREATE INDEX "IDX_simulation_runs_status_finished" ON "simulation_runs" ("status", "finished_at")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_simulation_runs_status_finished"`);
    await q.query(`CREATE TYPE "period" AS ENUM('CURRENT', 'NEXT_QUARTER')`);
    await q.query(`ALTER TABLE "simulation_runs" ADD "period" "period" NOT NULL DEFAULT 'CURRENT'`);
    await q.query(`CREATE INDEX "IDX_6b23d601993901a3b3652674e9" ON "simulation_runs" ("period", "status", "finished_at")`);
  }
}
