import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The capacity model is gone: slots are no longer counted, so a candidate is flagged only when no center is in reach.
 * Drops the slot columns it stored. Existing runs keep their flagged and desert figures, which were already the same
 * thing for cities with no center in reach, but their flagged counts also include slot overflow from before; run
 * `npm run simulate` once after migrating.
 */
export class DropCapacity1792600000011 implements MigrationInterface {
  name = 'DropCapacity1792600000011';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "area_utilization" DROP COLUMN "slots"`);
    await q.query(`ALTER TABLE "area_utilization" DROP COLUMN "used"`);
    await q.query(`ALTER TABLE "center_utilization" DROP COLUMN "slots"`);
    await q.query(`ALTER TABLE "center_utilization" DROP COLUMN "taken"`);
    await q.query(`ALTER TABLE "simulation_runs" DROP COLUMN "default_slots"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "simulation_runs" ADD "default_slots" integer NOT NULL DEFAULT 250`);
    await q.query(`ALTER TABLE "center_utilization" ADD "taken" integer NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE "center_utilization" ADD "slots" integer NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE "area_utilization" ADD "used" integer NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE "area_utilization" ADD "slots" integer NOT NULL DEFAULT 0`);
  }
}
