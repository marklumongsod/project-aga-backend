import { MigrationInterface, QueryRunner } from 'typeorm';

/** The service rate (and its `reach` denominator) is removed; nothing reads these columns any more. */
export class DropServiceRate1792600000010 implements MigrationInterface {
  name = 'DropServiceRate1792600000010';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "area_utilization" DROP COLUMN "service_rate"`);
    await q.query(`ALTER TABLE "area_utilization" DROP COLUMN "reach"`);
    await q.query(`ALTER TABLE "center_utilization" DROP COLUMN "service_rate"`);
    await q.query(`ALTER TABLE "center_utilization" DROP COLUMN "reach"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "center_utilization" ADD "reach" integer NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE "center_utilization" ADD "service_rate" double precision`);
    await q.query(`ALTER TABLE "area_utilization" ADD "reach" integer NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE "area_utilization" ADD "service_rate" double precision`);
  }
}
