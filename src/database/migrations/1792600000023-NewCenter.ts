import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stored New Assessment Center Model predictions. One row per request/model version, so the same planned center
 * can be compared across model versions later.
 */
export class NewCenter1792600000023 implements MigrationInterface {
  name = 'NewCenter1792600000023';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "new_center_predictions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "requested_by" uuid NOT NULL,
        "model_version" character varying NOT NULL,
        "last_month" bigint NOT NULL,
        "accreditation_month" bigint NOT NULL,
        "province_psgc" character(10) NOT NULL,
        "input" jsonb NOT NULL,
        "result" jsonb NOT NULL,
        "created_at" bigint NOT NULL DEFAULT (FLOOR(EXTRACT(EPOCH FROM now())))::bigint,
        CONSTRAINT "PK_new_center_predictions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_new_center_predictions_user" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_new_center_predictions_user" ON "new_center_predictions" ("requested_by")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_new_center_predictions_province" ON "new_center_predictions" ("province_psgc")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_new_center_predictions_accreditation" ON "new_center_predictions" ("accreditation_month")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_new_center_predictions_created" ON "new_center_predictions" ("created_at")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "new_center_predictions"`);
  }
}
