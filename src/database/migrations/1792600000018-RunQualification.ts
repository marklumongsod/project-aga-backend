import { MigrationInterface, QueryRunner } from 'typeorm';

/** A one-off run can be limited to one qualification: its upcoming graduates and the centers accredited for it. */
export class RunQualification1792600000018 implements MigrationInterface {
  name = 'RunQualification1792600000018';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "simulation_runs" ADD "qualification_key" character varying`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "simulation_runs" DROP COLUMN "qualification_key"`);
  }
}
