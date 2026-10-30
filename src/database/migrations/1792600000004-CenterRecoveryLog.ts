import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Audit trail for `npm run data:quality -- --apply`: centers that were excluded from the analysis and then recovered
 * after a statistical check. `before` holds what the row looked like, so `--revert` can put it back exactly.
 */
export class CenterRecoveryLog1792600000004 implements MigrationInterface {
  name = 'CenterRecoveryLog1792600000004';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "center_recovery_log" (
         "id" SERIAL NOT NULL,
         "center_id" integer NOT NULL,
         "method" character varying NOT NULL,
         "evidence" jsonb NOT NULL,
         "before" jsonb NOT NULL,
         "after" jsonb NOT NULL,
         "applied_at" bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()))::bigint,
         CONSTRAINT "PK_center_recovery_log" PRIMARY KEY ("id"),
         CONSTRAINT "UQ_center_recovery_log_center" UNIQUE ("center_id")
       )`,
    );
    await q.query(`COMMENT ON COLUMN "center_recovery_log"."applied_at" IS 'epoch seconds (UTC)'`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "center_recovery_log"`);
  }
}
