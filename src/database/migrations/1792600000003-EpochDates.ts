import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Team convention: epoch time in all date columns. Every date/timestamp column becomes a bigint of epoch seconds (UTC),
 * keeping the values it had. Columns that defaulted to now() default to the current epoch second instead.
 */
const EPOCH_NOW = '(EXTRACT(EPOCH FROM now()))::bigint';

export class EpochDates1792600000003 implements MigrationInterface {
  name = 'EpochDates1792600000003';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "assessment_centers" ALTER COLUMN "created_at" TYPE bigint USING EXTRACT(EPOCH FROM "created_at")::bigint`);
    await q.query(`COMMENT ON COLUMN "assessment_centers"."created_at" IS 'epoch seconds (UTC)'`);
    await q.query(`ALTER TABLE "assessments" ALTER COLUMN "applied_at" TYPE bigint USING EXTRACT(EPOCH FROM "applied_at")::bigint`);
    await q.query(`COMMENT ON COLUMN "assessments"."applied_at" IS 'epoch seconds (UTC)'`);
    await q.query(`ALTER TABLE "assessments" ALTER COLUMN "created_at" TYPE bigint USING EXTRACT(EPOCH FROM "created_at")::bigint`);
    await q.query(`COMMENT ON COLUMN "assessments"."created_at" IS 'epoch seconds (UTC)'`);
    await q.query(`ALTER TABLE "center_programs" ALTER COLUMN "accredited_at" TYPE bigint USING EXTRACT(EPOCH FROM "accredited_at")::bigint`);
    await q.query(`COMMENT ON COLUMN "center_programs"."accredited_at" IS 'epoch seconds (UTC)'`);
    await q.query(`ALTER TABLE "center_programs" ALTER COLUMN "expires_at" TYPE bigint USING EXTRACT(EPOCH FROM "expires_at")::bigint`);
    await q.query(`COMMENT ON COLUMN "center_programs"."expires_at" IS 'epoch seconds (UTC)'`);
    await q.query(`ALTER TABLE "center_schedules" ALTER COLUMN "started_at" TYPE bigint USING EXTRACT(EPOCH FROM "started_at")::bigint`);
    await q.query(`COMMENT ON COLUMN "center_schedules"."started_at" IS 'epoch seconds (UTC)'`);
    await q.query(`ALTER TABLE "enrollments" ALTER COLUMN "created_at" TYPE bigint USING EXTRACT(EPOCH FROM "created_at")::bigint`);
    await q.query(`COMMENT ON COLUMN "enrollments"."created_at" IS 'epoch seconds (UTC)'`);
    await q.query(`ALTER TABLE "labor_demand" ALTER COLUMN "period_start" TYPE bigint USING EXTRACT(EPOCH FROM "period_start")::bigint`);
    await q.query(`COMMENT ON COLUMN "labor_demand"."period_start" IS 'epoch seconds (UTC)'`);
    await q.query(`ALTER TABLE "simulation_runs" ALTER COLUMN "finished_at" TYPE bigint USING EXTRACT(EPOCH FROM "finished_at")::bigint`);
    await q.query(`COMMENT ON COLUMN "simulation_runs"."finished_at" IS 'epoch seconds (UTC)'`);
    await q.query(`ALTER TABLE "simulation_runs" ALTER COLUMN "started_at" DROP DEFAULT`);
    await q.query(`ALTER TABLE "simulation_runs" ALTER COLUMN "started_at" TYPE bigint USING EXTRACT(EPOCH FROM "started_at")::bigint`);
    await q.query(`ALTER TABLE "simulation_runs" ALTER COLUMN "started_at" SET DEFAULT ${EPOCH_NOW}`);
    await q.query(`COMMENT ON COLUMN "simulation_runs"."started_at" IS 'epoch seconds (UTC)'`);
    await q.query(`ALTER TABLE "travel_times" ALTER COLUMN "computed_at" DROP DEFAULT`);
    await q.query(`ALTER TABLE "travel_times" ALTER COLUMN "computed_at" TYPE bigint USING EXTRACT(EPOCH FROM "computed_at")::bigint`);
    await q.query(`ALTER TABLE "travel_times" ALTER COLUMN "computed_at" SET DEFAULT ${EPOCH_NOW}`);
    await q.query(`COMMENT ON COLUMN "travel_times"."computed_at" IS 'epoch seconds (UTC)'`);
    await q.query(`ALTER TABLE "users" ALTER COLUMN "created_at" DROP DEFAULT`);
    await q.query(`ALTER TABLE "users" ALTER COLUMN "created_at" TYPE bigint USING EXTRACT(EPOCH FROM "created_at")::bigint`);
    await q.query(`ALTER TABLE "users" ALTER COLUMN "created_at" SET DEFAULT ${EPOCH_NOW}`);
    await q.query(`COMMENT ON COLUMN "users"."created_at" IS 'epoch seconds (UTC)'`);
    await q.query(`ALTER TABLE "users" ALTER COLUMN "last_login_at" TYPE bigint USING EXTRACT(EPOCH FROM "last_login_at")::bigint`);
    await q.query(`COMMENT ON COLUMN "users"."last_login_at" IS 'epoch seconds (UTC)'`);
    await q.query(`ALTER TABLE "users" ALTER COLUMN "updated_at" DROP DEFAULT`);
    await q.query(`ALTER TABLE "users" ALTER COLUMN "updated_at" TYPE bigint USING EXTRACT(EPOCH FROM "updated_at")::bigint`);
    await q.query(`ALTER TABLE "users" ALTER COLUMN "updated_at" SET DEFAULT ${EPOCH_NOW}`);
    await q.query(`COMMENT ON COLUMN "users"."updated_at" IS 'epoch seconds (UTC)'`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`COMMENT ON COLUMN "users"."updated_at" IS NULL`);
    await q.query(`ALTER TABLE "users" ALTER COLUMN "updated_at" SET DEFAULT now()`);
    await q.query(`ALTER TABLE "users" ALTER COLUMN "updated_at" TYPE timestamptz USING to_timestamp("updated_at")`);
    await q.query(`ALTER TABLE "users" ALTER COLUMN "updated_at" DROP DEFAULT`);
    await q.query(`COMMENT ON COLUMN "users"."last_login_at" IS NULL`);
    await q.query(`ALTER TABLE "users" ALTER COLUMN "last_login_at" TYPE timestamptz USING to_timestamp("last_login_at")`);
    await q.query(`COMMENT ON COLUMN "users"."created_at" IS NULL`);
    await q.query(`ALTER TABLE "users" ALTER COLUMN "created_at" SET DEFAULT now()`);
    await q.query(`ALTER TABLE "users" ALTER COLUMN "created_at" TYPE timestamptz USING to_timestamp("created_at")`);
    await q.query(`ALTER TABLE "users" ALTER COLUMN "created_at" DROP DEFAULT`);
    await q.query(`COMMENT ON COLUMN "travel_times"."computed_at" IS NULL`);
    await q.query(`ALTER TABLE "travel_times" ALTER COLUMN "computed_at" SET DEFAULT now()`);
    await q.query(`ALTER TABLE "travel_times" ALTER COLUMN "computed_at" TYPE timestamptz USING to_timestamp("computed_at")`);
    await q.query(`ALTER TABLE "travel_times" ALTER COLUMN "computed_at" DROP DEFAULT`);
    await q.query(`COMMENT ON COLUMN "simulation_runs"."started_at" IS NULL`);
    await q.query(`ALTER TABLE "simulation_runs" ALTER COLUMN "started_at" SET DEFAULT now()`);
    await q.query(`ALTER TABLE "simulation_runs" ALTER COLUMN "started_at" TYPE timestamptz USING to_timestamp("started_at")`);
    await q.query(`ALTER TABLE "simulation_runs" ALTER COLUMN "started_at" DROP DEFAULT`);
    await q.query(`COMMENT ON COLUMN "simulation_runs"."finished_at" IS NULL`);
    await q.query(`ALTER TABLE "simulation_runs" ALTER COLUMN "finished_at" TYPE timestamptz USING to_timestamp("finished_at")`);
    await q.query(`COMMENT ON COLUMN "labor_demand"."period_start" IS NULL`);
    await q.query(`ALTER TABLE "labor_demand" ALTER COLUMN "period_start" TYPE timestamptz USING to_timestamp("period_start")`);
    await q.query(`COMMENT ON COLUMN "enrollments"."created_at" IS NULL`);
    await q.query(`ALTER TABLE "enrollments" ALTER COLUMN "created_at" TYPE timestamptz USING to_timestamp("created_at")`);
    await q.query(`COMMENT ON COLUMN "center_schedules"."started_at" IS NULL`);
    await q.query(`ALTER TABLE "center_schedules" ALTER COLUMN "started_at" TYPE timestamptz USING to_timestamp("started_at")`);
    await q.query(`COMMENT ON COLUMN "center_programs"."expires_at" IS NULL`);
    await q.query(`ALTER TABLE "center_programs" ALTER COLUMN "expires_at" TYPE timestamptz USING to_timestamp("expires_at")`);
    await q.query(`COMMENT ON COLUMN "center_programs"."accredited_at" IS NULL`);
    await q.query(`ALTER TABLE "center_programs" ALTER COLUMN "accredited_at" TYPE timestamptz USING to_timestamp("accredited_at")`);
    await q.query(`COMMENT ON COLUMN "assessments"."created_at" IS NULL`);
    await q.query(`ALTER TABLE "assessments" ALTER COLUMN "created_at" TYPE timestamptz USING to_timestamp("created_at")`);
    await q.query(`COMMENT ON COLUMN "assessments"."applied_at" IS NULL`);
    await q.query(`ALTER TABLE "assessments" ALTER COLUMN "applied_at" TYPE timestamptz USING to_timestamp("applied_at")`);
    await q.query(`COMMENT ON COLUMN "assessment_centers"."created_at" IS NULL`);
    await q.query(`ALTER TABLE "assessment_centers" ALTER COLUMN "created_at" TYPE timestamptz USING to_timestamp("created_at")`);
  }
}
