import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropCenterSlotsOverride1792600000000 implements MigrationInterface {
  name = 'DropCenterSlotsOverride1792600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "assessment_centers" DROP COLUMN "slots_per_quarter"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "assessment_centers" ADD "slots_per_quarter" integer`);
  }
}
