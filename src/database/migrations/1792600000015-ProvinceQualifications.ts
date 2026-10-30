import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Graduates per province and qualification (from the team's graduate list, as counts only). Used to suggest which
 * qualifications a new center should offer. Load it with `npm run data:qualifications`.
 */
export class ProvinceQualifications1792600000015 implements MigrationInterface {
  name = 'ProvinceQualifications1792600000015';

  public async up(q: QueryRunner): Promise<void> {
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
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "province_qualification_graduates"`);
  }
}
