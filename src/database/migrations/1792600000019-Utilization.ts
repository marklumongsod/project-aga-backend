import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Capacity-based utilization, per center × qualification × month/quarter.
 *
 * Slots are stored monthly (20 per program per center per month in the demo) and a quarter is their sum.
 * `area_utilization` / `center_utilization` gain nullable capacity fields; only qualification + quarter runs fill them.
 * `upcoming_graduates.source` separates the nightly TESDA data from local demo rows.
 */
export class Utilization1792600000019 implements MigrationInterface {
  name = 'Utilization1792600000019';

  public async up(q: QueryRunner): Promise<void> {
    // Remove the columns left by the discarded reach-based service-rate experiment, if this database has them.
    await q.query(`ALTER TABLE "area_utilization" DROP COLUMN IF EXISTS "served"`);
    await q.query(`ALTER TABLE "area_utilization" DROP COLUMN IF EXISTS "service_rate"`);
    await q.query(`ALTER TABLE "center_utilization" DROP COLUMN IF EXISTS "reach"`);
    await q.query(`ALTER TABLE "center_utilization" DROP COLUMN IF EXISTS "service_rate"`);

    await q.query(`ALTER TABLE "simulation_runs" ADD "quarter_start" bigint`);
    await q.query(`ALTER TABLE "area_utilization" ADD "slots" integer`);
    await q.query(`ALTER TABLE "area_utilization" ADD "assigned" integer`);
    await q.query(`ALTER TABLE "area_utilization" ADD "utilization" double precision`);
    await q.query(`ALTER TABLE "area_utilization" ADD "service_rate" double precision`);
    await q.query(`ALTER TABLE "center_utilization" ADD "slots" integer`);
    await q.query(`ALTER TABLE "center_utilization" ADD "assigned" integer`);
    await q.query(`ALTER TABLE "center_utilization" ADD "utilization" double precision`);
    await q.query(`ALTER TABLE "center_utilization" ADD "service_rate" double precision`);

    await q.query(`ALTER TABLE "upcoming_graduates" ADD "source" character varying NOT NULL DEFAULT 'tesda'`);
    await q.query(`CREATE INDEX "IDX_upcoming_graduates_source" ON "upcoming_graduates" ("source")`);

    await q.query(
      `CREATE TABLE "center_qualification_slots" (
         "id" SERIAL NOT NULL,
         "center_id" integer NOT NULL,
         "qualification_key" character varying NOT NULL,
         "qualification_id" integer,
         "qualification" character varying NOT NULL,
         "month_start" bigint NOT NULL,
         "slots" integer NOT NULL,
         "source" character varying NOT NULL DEFAULT 'demo',
         "as_of" bigint NOT NULL,
         CONSTRAINT "PK_center_qualification_slots" PRIMARY KEY ("id"),
         CONSTRAINT "CHK_center_qualification_slots_nonnegative" CHECK ("slots" >= 0),
         CONSTRAINT "UQ_center_qualification_slots" UNIQUE ("center_id", "qualification_key", "month_start"),
         CONSTRAINT "FK_center_qualification_slots_center" FOREIGN KEY ("center_id") REFERENCES "assessment_centers"("id") ON DELETE CASCADE,
         CONSTRAINT "FK_center_qualification_slots_qualification" FOREIGN KEY ("qualification_id") REFERENCES "qualifications"("id") ON DELETE SET NULL
       )`,
    );
    await q.query(`CREATE INDEX "IDX_center_qualification_slots_center" ON "center_qualification_slots" ("center_id")`);
    await q.query(`CREATE INDEX "IDX_center_qualification_slots_key" ON "center_qualification_slots" ("qualification_key")`);
    await q.query(`CREATE INDEX "IDX_center_qualification_slots_month" ON "center_qualification_slots" ("month_start")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "center_qualification_slots"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_upcoming_graduates_source"`);
    await q.query(`ALTER TABLE "upcoming_graduates" DROP COLUMN "source"`);
    await q.query(`ALTER TABLE "center_utilization" DROP COLUMN "service_rate"`);
    await q.query(`ALTER TABLE "center_utilization" DROP COLUMN "utilization"`);
    await q.query(`ALTER TABLE "center_utilization" DROP COLUMN "assigned"`);
    await q.query(`ALTER TABLE "center_utilization" DROP COLUMN "slots"`);
    await q.query(`ALTER TABLE "area_utilization" DROP COLUMN "service_rate"`);
    await q.query(`ALTER TABLE "area_utilization" DROP COLUMN "utilization"`);
    await q.query(`ALTER TABLE "area_utilization" DROP COLUMN "assigned"`);
    await q.query(`ALTER TABLE "area_utilization" DROP COLUMN "slots"`);
    await q.query(`ALTER TABLE "simulation_runs" DROP COLUMN "quarter_start"`);
  }
}
