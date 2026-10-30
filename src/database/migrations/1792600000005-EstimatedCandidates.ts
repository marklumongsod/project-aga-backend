import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * How many of an area's candidates are an even share of a larger total (BSRS has a count for only some cities; the rest
 * of the province total is split evenly over its other cities) rather than a count. Re-run `npm run simulate` to fill it.
 */
export class EstimatedCandidates1792600000005 implements MigrationInterface {
  name = 'EstimatedCandidates1792600000005';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "area_utilization" ADD "estimated_candidates" integer NOT NULL DEFAULT 0`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "area_utilization" DROP COLUMN "estimated_candidates"`);
  }
}
