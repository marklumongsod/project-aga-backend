import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Report numbers by day: GA-yyyymmdd-#, where # is the report's place in that day's lineup (Asia/Manila day).
 * `report_day` is the day as yyyymmdd (an integer, not a date column) and `day_no` the lineup number, kept when
 * other reports are deleted. Existing proposals get theirs from their creation time, in save order.
 */
export class ProposalDayNumber1792600000023 implements MigrationInterface {
  name = 'ProposalDayNumber1792600000023';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "report_day" integer`);
    await q.query(`ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "day_no" integer`);
    await q.query(
      `UPDATE "proposals" p SET report_day = n.day, day_no = n.no
         FROM (SELECT id,
                      to_char(to_timestamp(created_at) AT TIME ZONE 'Asia/Manila', 'YYYYMMDD')::int AS day,
                      row_number() OVER (PARTITION BY to_char(to_timestamp(created_at) AT TIME ZONE 'Asia/Manila', 'YYYYMMDD')
                                         ORDER BY report_no) AS no
                 FROM "proposals") n
        WHERE n.id = p.id AND p.day_no IS NULL`,
    );
    await q.query(`ALTER TABLE "proposals" ALTER COLUMN "report_day" SET NOT NULL`);
    await q.query(`ALTER TABLE "proposals" ALTER COLUMN "day_no" SET NOT NULL`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_proposals_day_no" ON "proposals" ("report_day", "day_no")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "UQ_proposals_day_no"`);
    await q.query(`ALTER TABLE "proposals" DROP COLUMN IF EXISTS "day_no"`);
    await q.query(`ALTER TABLE "proposals" DROP COLUMN IF EXISTS "report_day"`);
  }
}
