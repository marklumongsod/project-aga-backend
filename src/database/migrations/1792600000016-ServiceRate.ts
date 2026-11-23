import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reach-based service rate. Slots are still not counted, so this is access coverage, not utilization:
 *   area:   served = candidates - flagged; service_rate = served / candidates
 *   center: reach = candidates in every city the center can reach; service_rate = demand / reach
 * Existing area rows are backfilled because served is derivable from candidates - flagged. Center reach needs the
 * engine's reach list, so old runs keep null until the next `npm run simulate`.
 */
export class ServiceRate1792600000016 implements MigrationInterface {
  name = 'ServiceRate1792600000016';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "area_utilization" ADD "served" integer`);
    await q.query(`ALTER TABLE "area_utilization" ADD "service_rate" double precision`);
    await q.query(
      `UPDATE "area_utilization"
          SET "served" = "candidates" - "flagged",
              "service_rate" = CASE WHEN "candidates" > 0
                                    THEN ("candidates" - "flagged")::float8 / "candidates"
                                    ELSE NULL END`,
    );
    await q.query(`ALTER TABLE "area_utilization" ALTER COLUMN "served" SET NOT NULL`);
    await q.query(`ALTER TABLE "area_utilization" ALTER COLUMN "served" SET DEFAULT 0`);

    await q.query(`ALTER TABLE "center_utilization" ADD "reach" integer`);
    await q.query(`ALTER TABLE "center_utilization" ADD "service_rate" double precision`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "center_utilization" DROP COLUMN "service_rate"`);
    await q.query(`ALTER TABLE "center_utilization" DROP COLUMN "reach"`);
    await q.query(`ALTER TABLE "area_utilization" DROP COLUMN "service_rate"`);
    await q.query(`ALTER TABLE "area_utilization" DROP COLUMN "served"`);
  }
}
