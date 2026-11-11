import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Candidates now come only from the TESDA API's upcoming graduates (`upcoming_graduates`, synced monthly). The BSRS
 * completed-scholar counts (`bsrs_stats`, seeded from bsrs_stats.json, never updated) are dropped.
 */
export class DropBsrsStats1792600000020 implements MigrationInterface {
  name = 'DropBsrsStats1792600000020';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "bsrs_stats"`);
  }

  /** Restores the structure only; the rows came from the removed bsrs_stats.json and stay empty. */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "bsrs_stats" ("id" SERIAL NOT NULL, "level" "public"."area_level" NOT NULL, "source_name" character varying NOT NULL,
        "region_psgc" character(10), "province_psgc" character(10), "city_key" character varying, "city_keys" text array NOT NULL DEFAULT '{}',
        "enrolled" integer NOT NULL, "completed" integer NOT NULL, "completion_rate" double precision NOT NULL,
        "period_label" character varying NOT NULL DEFAULT 'cumulative', CONSTRAINT "PK_2961978cbb8b3acc9126cc4cc97" PRIMARY KEY ("id"))`,
    );
    await q.query(`CREATE INDEX "IDX_44c8fdd043c91256c75f66f1c2" ON "bsrs_stats" ("province_psgc")`);
    await q.query(`CREATE INDEX "IDX_2538cada48c6ef09366f3d205d" ON "bsrs_stats" ("level", "region_psgc")`);
  }
}
