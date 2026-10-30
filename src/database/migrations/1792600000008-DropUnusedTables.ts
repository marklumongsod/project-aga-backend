import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops tables nothing reads any more:
 *   - center_programs, center_schedules, assessments: T2MIS program data for ~200 centers, replaced by the TESDA API's
 *     center_qualifications (every listed center);
 *   - enrollments, bsrs_qualification_stats: loaded by the seed, never used;
 *   - labor_demand: the Labor Market Information table, empty (the source sheet was empty).
 * `down` recreates them empty, as they were after EpochDates; `npm run db:seed` from an older checkout refills them.
 */
export class DropUnusedTables1792600000008 implements MigrationInterface {
  name = 'DropUnusedTables1792600000008';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "assessments"`);
    await q.query(`DROP TABLE "center_schedules"`);
    await q.query(`DROP TABLE "center_programs"`);
    await q.query(`DROP TABLE "enrollments"`);
    await q.query(`DROP TABLE "bsrs_qualification_stats"`);
    await q.query(`DROP TABLE "labor_demand"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "labor_demand" ("id" SERIAL NOT NULL, "region_psgc" character(10), "province_psgc" character(10), "sector" character varying NOT NULL, "vacancies" integer NOT NULL, "period_start" bigint NOT NULL, "source" character varying NOT NULL, CONSTRAINT "PK_d1b4aa415dca4580c3c2df719a9" PRIMARY KEY ("id"))`,
    );
    await q.query(`CREATE INDEX "IDX_8dd58a6fad10a31551e3b98f52" ON "labor_demand" ("region_psgc", "province_psgc")`);
    await q.query(
      `CREATE TABLE "bsrs_qualification_stats" ("id" SERIAL NOT NULL, "region_name" character varying NOT NULL, "province_name" character varying NOT NULL, "city_name" character varying NOT NULL, "qualification" character varying NOT NULL, "qualification_id" integer, "enrolled" integer NOT NULL, "completed" integer NOT NULL, CONSTRAINT "PK_9bb251928e9b41e172d8f598327" PRIMARY KEY ("id"))`,
    );
    await q.query(
      `CREATE TABLE "enrollments" ("id" integer NOT NULL, "training_schedule_id" integer, "train_status_id" integer, "train_result_id" integer, "scholarship_type_id" integer, "created_at" bigint, CONSTRAINT "PK_7c0f752f9fb68bf6ed7367ab00f" PRIMARY KEY ("id"))`,
    );
    await q.query(`CREATE INDEX "IDX_a8e683f4ec73be1353dcc1b6e3" ON "enrollments" ("created_at")`);
    await q.query(
      `CREATE TABLE "center_programs" ("id" integer NOT NULL, "center_id" integer NOT NULL, "qualification_id" integer NOT NULL, "accreditation_no" character varying, "accredited_at" bigint, "expires_at" bigint, CONSTRAINT "PK_d372c4c47fd0ee86800ee1c8f5d" PRIMARY KEY ("id"))`,
    );
    await q.query(`CREATE INDEX "IDX_a4bdc96cd4b175f6accab14f34" ON "center_programs" ("center_id")`);
    await q.query(`CREATE INDEX "IDX_3c2cfc6dd27ca8bb7377840bf9" ON "center_programs" ("qualification_id")`);
    await q.query(
      `CREATE TABLE "center_schedules" ("id" integer NOT NULL, "center_program_id" integer NOT NULL, "started_at" bigint, CONSTRAINT "PK_d878434425ba6f75275aff83cdd" PRIMARY KEY ("id"))`,
    );
    await q.query(`CREATE INDEX "IDX_10628a03a34121e94abaca5c7d" ON "center_schedules" ("center_program_id")`);
    await q.query(
      `CREATE TABLE "assessments" ("id" integer NOT NULL, "center_schedule_id" integer NOT NULL, "result_id" integer, "applied_at" bigint, "created_at" bigint, CONSTRAINT "PK_a3442bd80a00e9111cefca57f6c" PRIMARY KEY ("id"))`,
    );
    await q.query(`CREATE INDEX "IDX_8d714e8885410de2fba4599ad1" ON "assessments" ("center_schedule_id")`);
    for (const [t, c] of [
      ['assessments', 'applied_at'],
      ['assessments', 'created_at'],
      ['center_programs', 'accredited_at'],
      ['center_programs', 'expires_at'],
      ['center_schedules', 'started_at'],
      ['enrollments', 'created_at'],
      ['labor_demand', 'period_start'],
    ])
      await q.query(`COMMENT ON COLUMN "${t}"."${c}" IS 'epoch seconds (UTC)'`);
    await q.query(
      `ALTER TABLE "center_programs" ADD CONSTRAINT "FK_a4bdc96cd4b175f6accab14f344" FOREIGN KEY ("center_id") REFERENCES "assessment_centers"("id")`,
    );
    await q.query(
      `ALTER TABLE "center_programs" ADD CONSTRAINT "FK_3c2cfc6dd27ca8bb7377840bf9b" FOREIGN KEY ("qualification_id") REFERENCES "qualifications"("id")`,
    );
    await q.query(
      `ALTER TABLE "center_schedules" ADD CONSTRAINT "FK_10628a03a34121e94abaca5c7d3" FOREIGN KEY ("center_program_id") REFERENCES "center_programs"("id")`,
    );
    await q.query(
      `ALTER TABLE "assessments" ADD CONSTRAINT "FK_8d714e8885410de2fba4599ad15" FOREIGN KEY ("center_schedule_id") REFERENCES "center_schedules"("id")`,
    );
  }
}
