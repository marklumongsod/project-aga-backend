import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Qualifications come only from the TESDA API, identified by name ("Cookery II"). The T2MIS catalog (`qualifications`,
 * seeded from qualifications.json) only attached a QualId and code to about 80% of those names; it is dropped with the
 * `qualification_id` columns that pointed at it.
 */
export class DropT2misQualifications1792600000019 implements MigrationInterface {
  name = 'DropT2misQualifications1792600000019';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "center_qualifications" DROP CONSTRAINT IF EXISTS "FK_center_qualifications_qualification"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_center_qualifications_qualification_id"`);
    await q.query(`ALTER TABLE "center_qualifications" DROP COLUMN "qualification_id"`);
    await q.query(`ALTER TABLE "upcoming_graduates" DROP CONSTRAINT IF EXISTS "FK_upcoming_graduates_qualification"`);
    await q.query(`ALTER TABLE "upcoming_graduates" DROP COLUMN "qualification_id"`);
    await q.query(`DROP TABLE "qualifications"`);
  }

  /** Restores the structure only; the catalog rows came from the removed qualifications.json and stay empty. */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "qualifications" ("id" integer NOT NULL, "sector_id" integer, "title" character varying NOT NULL, "code" character varying,
        "level_id" integer, "enabled" boolean NOT NULL DEFAULT true, CONSTRAINT "PK_9ed4d526ac3b76ba3f1c1080433" PRIMARY KEY ("id"))`,
    );
    await q.query(`CREATE INDEX "IDX_172413323c5498c9cf2edd861e" ON "qualifications" ("title")`);
    await q.query(`ALTER TABLE "upcoming_graduates" ADD "qualification_id" integer`);
    await q.query(
      `ALTER TABLE "upcoming_graduates" ADD CONSTRAINT "FK_upcoming_graduates_qualification" FOREIGN KEY ("qualification_id") REFERENCES "qualifications"("id") ON DELETE SET NULL`,
    );
    await q.query(`ALTER TABLE "center_qualifications" ADD "qualification_id" integer`);
    await q.query(`CREATE INDEX "IDX_center_qualifications_qualification_id" ON "center_qualifications" ("qualification_id")`);
    await q.query(
      `ALTER TABLE "center_qualifications" ADD CONSTRAINT "FK_center_qualifications_qualification" FOREIGN KEY ("qualification_id") REFERENCES "qualifications"("id") ON DELETE SET NULL`,
    );
  }
}
