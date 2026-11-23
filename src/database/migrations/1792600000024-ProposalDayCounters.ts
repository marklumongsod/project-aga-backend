import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The last report number given out each day (`GA-yyyymmdd-#`), so a number is never given again, even when the day's
 * newest reports are deleted. Saving takes the next number with an upsert on the day's row. Seeded from the numbers
 * already in use. Safe to run where the table already exists.
 */
export class ProposalDayCounters1792600000024 implements MigrationInterface {
  name = 'ProposalDayCounters1792600000024';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE IF NOT EXISTS "proposal_day_counters" ("report_day" integer PRIMARY KEY, "last_no" integer NOT NULL)`,
    );
    await q.query(
      `INSERT INTO "proposal_day_counters" (report_day, last_no)
       SELECT report_day, max(day_no) FROM "proposals" GROUP BY report_day
       ON CONFLICT (report_day) DO UPDATE SET last_no = GREATEST("proposal_day_counters".last_no, EXCLUDED.last_no)`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "proposal_day_counters"`);
  }
}
