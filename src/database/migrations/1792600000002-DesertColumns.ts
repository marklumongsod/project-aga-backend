import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Assessment deserts (team doc): a city/municipality with candidates and no assessment center reachable within the
 * travel limit. Stored per run so the dashboards can show them without re-running anything.
 *   - desert_level (cities): 1-4 by candidate count, 0 = not a desert. Regions/provinces: the highest level inside.
 *   - desert_cities / desert_candidates: how many desert cities (and candidates in them) the area contains.
 *   - nearest_minutes (cities): travel time to the nearest reachable center, null when there is none.
 * Existing runs keep zeros until `npm run simulate` is run again.
 */
export class DesertColumns1792600000002 implements MigrationInterface {
  name = 'DesertColumns1792600000002';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "area_utilization" ADD "desert_level" smallint NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE "area_utilization" ADD "desert_cities" integer NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE "area_utilization" ADD "desert_candidates" integer NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE "area_utilization" ADD "nearest_minutes" real`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "area_utilization" DROP COLUMN "nearest_minutes"`);
    await q.query(`ALTER TABLE "area_utilization" DROP COLUMN "desert_candidates"`);
    await q.query(`ALTER TABLE "area_utilization" DROP COLUMN "desert_cities"`);
    await q.query(`ALTER TABLE "area_utilization" DROP COLUMN "desert_level"`);
  }
}
