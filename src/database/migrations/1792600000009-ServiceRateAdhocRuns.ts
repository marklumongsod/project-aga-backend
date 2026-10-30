import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Utilization rate is replaced by the service rate: candidates a center served / candidates within its reach (areas:
 * the same ratio over their centers). `reach` is the denominator; `service_rate` is stored so the dashboard can sort
 * and color by it. `simulation_runs.adhoc` marks runs made for a one-off travel limit (?limitMinutes=): short-lived,
 * never part of the history, the trend or the stored daily results.
 * Existing rows have no reach/service rate until the next `npm run simulate`.
 */
export class ServiceRateAdhocRuns1792600000009 implements MigrationInterface {
  name = 'ServiceRateAdhocRuns1792600000009';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "area_utilization" DROP COLUMN "rate"`);
    await q.query(`ALTER TABLE "area_utilization" ADD "reach" integer NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE "area_utilization" ADD "service_rate" double precision`);
    await q.query(`ALTER TABLE "center_utilization" DROP COLUMN "rate"`);
    await q.query(`ALTER TABLE "center_utilization" ADD "reach" integer NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE "center_utilization" ADD "service_rate" double precision`);
    await q.query(`ALTER TABLE "simulation_runs" ADD "adhoc" boolean NOT NULL DEFAULT false`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "simulation_runs" DROP COLUMN "adhoc"`);
    await q.query(`ALTER TABLE "center_utilization" DROP COLUMN "service_rate"`);
    await q.query(`ALTER TABLE "center_utilization" DROP COLUMN "reach"`);
    await q.query(`ALTER TABLE "center_utilization" ADD "rate" double precision NOT NULL DEFAULT 0`);
    await q.query(`ALTER TABLE "area_utilization" DROP COLUMN "service_rate"`);
    await q.query(`ALTER TABLE "area_utilization" DROP COLUMN "reach"`);
    await q.query(`ALTER TABLE "area_utilization" ADD "rate" double precision`);
  }
}
