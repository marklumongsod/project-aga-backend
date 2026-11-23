import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The parts of a user's name, as T2MIS SSO sends them (FirstName, MiddleName, LastName), so a report can print
 * "Prepared by: Surname, First Name MI". Null for accounts that did not come from SSO (they keep `name` only).
 */
export class UserNameParts1792600000022 implements MigrationInterface {
  name = 'UserNameParts1792600000022';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "first_name" character varying`);
    await q.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "middle_name" character varying`);
    await q.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_name" character varying`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "last_name"`);
    await q.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "middle_name"`);
    await q.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "first_name"`);
  }
}
