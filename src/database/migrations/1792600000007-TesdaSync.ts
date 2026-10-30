import { MigrationInterface, QueryRunner } from 'typeorm';

const FLOOR_NOW = '(FLOOR(EXTRACT(EPOCH FROM now())))::bigint';

/**
 * Assessment centers now come from the TESDA Assessor Coverage API (synced nightly, `npm run tesda:sync`).
 *   - assessment_centers.tesda_listed: null = never synced (seed data), true/false = in the latest API pull or not.
 *     Only listed centers are in the analysis. Unlisted rows stay so old simulation results keep their foreign keys.
 *   - center_qualifications: what each center is accredited for, as the API names it (matched to a T2MIS QualId
 *     where the name matches one).
 *   - school_graduates: graduates finishing training per school and month (counts only, no student details).
 *   - tesda_syncs: when each sync ran and what it loaded.
 */
export class TesdaSync1792600000007 implements MigrationInterface {
  name = 'TesdaSync1792600000007';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "assessment_centers" ADD "website" character varying`);
    await q.query(`ALTER TABLE "assessment_centers" ADD "accredited_until" bigint`);
    await q.query(`ALTER TABLE "assessment_centers" ADD "tesda_listed" boolean`);
    await q.query(`ALTER TABLE "assessment_centers" ADD "synced_at" bigint`);

    await q.query(
      `CREATE TABLE "center_qualifications" ("center_id" integer NOT NULL, "qualification" character varying NOT NULL,
        "qualification_id" integer, "accredited_until" bigint,
        CONSTRAINT "PK_center_qualifications" PRIMARY KEY ("center_id", "qualification"))`,
    );
    await q.query(`CREATE INDEX "IDX_center_qualifications_qualification_id" ON "center_qualifications" ("qualification_id")`);
    await q.query(`CREATE INDEX "IDX_center_qualifications_qualification" ON "center_qualifications" (lower("qualification"))`);
    await q.query(
      `ALTER TABLE "center_qualifications" ADD CONSTRAINT "FK_center_qualifications_center" FOREIGN KEY ("center_id") REFERENCES "assessment_centers"("id") ON DELETE CASCADE`,
    );
    await q.query(
      `ALTER TABLE "center_qualifications" ADD CONSTRAINT "FK_center_qualifications_qualification" FOREIGN KEY ("qualification_id") REFERENCES "qualifications"("id") ON DELETE SET NULL`,
    );

    await q.query(
      `CREATE TABLE "school_graduates" ("school_id" integer NOT NULL, "month" bigint NOT NULL, "school_name" character varying,
        "province_name" character varying, "lat" double precision NOT NULL, "lon" double precision NOT NULL, "city_id" integer,
        "graduates" integer NOT NULL, CONSTRAINT "PK_school_graduates" PRIMARY KEY ("school_id", "month"))`,
    );
    await q.query(`CREATE INDEX "IDX_school_graduates_month" ON "school_graduates" ("month")`);
    await q.query(
      `ALTER TABLE "school_graduates" ADD CONSTRAINT "FK_school_graduates_city" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE SET NULL`,
    );

    await q.query(
      `CREATE TABLE "tesda_syncs" ("id" SERIAL NOT NULL, "started_at" bigint NOT NULL DEFAULT ${FLOOR_NOW}, "finished_at" bigint,
        "status" character varying NOT NULL, "triggered_by" character varying NOT NULL, "tesda_run_at" bigint, "stats" jsonb,
        "error" text, CONSTRAINT "PK_tesda_syncs" PRIMARY KEY ("id"))`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "tesda_syncs"`);
    await q.query(`DROP TABLE "school_graduates"`);
    await q.query(`DROP TABLE "center_qualifications"`);
    await q.query(`ALTER TABLE "assessment_centers" DROP COLUMN "synced_at"`);
    await q.query(`ALTER TABLE "assessment_centers" DROP COLUMN "tesda_listed"`);
    await q.query(`ALTER TABLE "assessment_centers" DROP COLUMN "accredited_until"`);
    await q.query(`ALTER TABLE "assessment_centers" DROP COLUMN "website"`);
  }
}
