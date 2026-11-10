import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Graduates now come from the TESDA API's students list (GET /api/v1/students/all, synced nightly), summed per town or
 * province, qualification and finish month: counts only, no student rows. It replaces both older sources:
 *   - school_graduates (graduates per school, from the API's coverage endpoint, which the API no longer lists)
 *   - province_qualification_graduates (the team's graduate list, loaded from a seed file)
 * `city_id` is null when the API only knows the graduate's province.
 */
export class UpcomingGraduates1792600000017 implements MigrationInterface {
  name = 'UpcomingGraduates1792600000017';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "upcoming_graduates" ("id" SERIAL NOT NULL, "province_psgc" character(10) NOT NULL, "city_id" integer,
        "qualification" character varying NOT NULL, "qualification_id" integer, "finish_month" bigint NOT NULL,
        "graduates" integer NOT NULL, CONSTRAINT "PK_upcoming_graduates" PRIMARY KEY ("id"))`,
    );
    await q.query(`CREATE INDEX "IDX_upcoming_graduates_province" ON "upcoming_graduates" ("province_psgc")`);
    await q.query(`CREATE INDEX "IDX_upcoming_graduates_city" ON "upcoming_graduates" ("city_id")`);
    await q.query(
      `ALTER TABLE "upcoming_graduates" ADD CONSTRAINT "FK_upcoming_graduates_province" FOREIGN KEY ("province_psgc") REFERENCES "provinces"("psgc") ON DELETE CASCADE`,
    );
    await q.query(
      `ALTER TABLE "upcoming_graduates" ADD CONSTRAINT "FK_upcoming_graduates_city" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE SET NULL`,
    );
    await q.query(
      `ALTER TABLE "upcoming_graduates" ADD CONSTRAINT "FK_upcoming_graduates_qualification" FOREIGN KEY ("qualification_id") REFERENCES "qualifications"("id") ON DELETE SET NULL`,
    );
    await q.query(`DROP TABLE "school_graduates"`);
    await q.query(`DROP TABLE "province_qualification_graduates"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "province_qualification_graduates" (
         "province_psgc" character(10) NOT NULL,
         "qualification_id" integer NOT NULL,
         "qualification" character varying NOT NULL,
         "graduates" integer NOT NULL,
         CONSTRAINT "PK_province_qualification_graduates" PRIMARY KEY ("province_psgc", "qualification_id"),
         CONSTRAINT "FK_pqg_province" FOREIGN KEY ("province_psgc") REFERENCES "provinces"("psgc") ON DELETE CASCADE
       )`,
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
    await q.query(`DROP TABLE "upcoming_graduates"`);
  }
}
