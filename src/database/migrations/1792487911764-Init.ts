import { MigrationInterface, QueryRunner } from 'typeorm';

/** Initial schema: PSGC geography, T2MIS reference data, BSRS demand, accounts, simulation results. */

export class Init1792487911764 implements MigrationInterface {
  name = 'Init1792487911764';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS postgis`);
    await queryRunner.query(
      `CREATE TABLE "regions" ("psgc" character(10) NOT NULL, "name" character varying NOT NULL, "geom" geometry(MultiPolygon,4326), CONSTRAINT "PK_85155439b0eabd5b6549d854b55" PRIMARY KEY ("psgc"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "provinces" ("psgc" character(10) NOT NULL, "name" character varying NOT NULL, "region_psgc" character(10) NOT NULL, "geom" geometry(MultiPolygon,4326), CONSTRAINT "PK_a57232928521c3d89e7f13fe8ac" PRIMARY KEY ("psgc"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_f21a1a9a90933151c762127ed5" ON "provinces" ("region_psgc") `);
    await queryRunner.query(
      `CREATE TABLE "cities" ("id" SERIAL NOT NULL, "key" character varying NOT NULL, "psgc" character(10), "name" character varying NOT NULL, "province_psgc" character(10) NOT NULL, "region_psgc" character(10) NOT NULL, "derived_boundary" boolean NOT NULL DEFAULT false, "island_id" integer NOT NULL, "lat" double precision NOT NULL, "lon" double precision NOT NULL, "geom" geometry(MultiPolygon,4326), "centroid" geometry(Point,4326), CONSTRAINT "PK_4762ffb6e5d198cfec5606bc11e" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_5c147d7fa47d3d11ab09435322" ON "cities" ("key") `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_8714a17ea20e41fd4f61e4a8c9" ON "cities" ("psgc") WHERE psgc IS NOT NULL`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_df04d69306c28bee2afdc02167" ON "cities" ("province_psgc") `);
    await queryRunner.query(`CREATE INDEX "IDX_dc558d5cf8a55656e805a49d2d" ON "cities" ("region_psgc") `);
    await queryRunner.query(
      `CREATE TABLE "qualifications" ("id" integer NOT NULL, "sector_id" integer, "title" character varying NOT NULL, "code" character varying, "level_id" integer, "enabled" boolean NOT NULL DEFAULT true, CONSTRAINT "PK_9ed4d526ac3b76ba3f1c1080433" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_172413323c5498c9cf2edd861e" ON "qualifications" ("title") `);
    await queryRunner.query(
      `CREATE TABLE "assessment_centers" ("id" integer NOT NULL, "name" character varying NOT NULL, "address" character varying, "phone" character varying, "email" character varying, "district" character varying, "source_region_name" character varying, "source_province_name" character varying, "source_city_name" character varying, "lat" double precision NOT NULL, "lon" double precision NOT NULL, "location" geometry(Point,4326), "coord_status" character varying NOT NULL, "coord_source" character varying NOT NULL, "is_foreign" boolean NOT NULL DEFAULT false, "is_closed" boolean NOT NULL DEFAULT false, "is_hidden" boolean NOT NULL DEFAULT false, "include_in_analysis" boolean NOT NULL DEFAULT true, "city_id" integer, "province_psgc" character(10), "region_psgc" character(10), "island_id" integer, "slots_per_quarter" integer, "created_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_170239ca8688c3158eb55f79ee8" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_4395f9c98c1d1f63eee3e11367" ON "assessment_centers" ("include_in_analysis") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cd795bd968969d1f5bb0137552" ON "assessment_centers" ("province_psgc") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_e952ec143a3714ed1defa92b2b" ON "assessment_centers" ("region_psgc") `,
    );
    await queryRunner.query(
      `CREATE TABLE "center_programs" ("id" integer NOT NULL, "center_id" integer NOT NULL, "qualification_id" integer NOT NULL, "accreditation_no" character varying, "accredited_at" TIMESTAMP WITH TIME ZONE, "expires_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_d372c4c47fd0ee86800ee1c8f5d" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_a4bdc96cd4b175f6accab14f34" ON "center_programs" ("center_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_3c2cfc6dd27ca8bb7377840bf9" ON "center_programs" ("qualification_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "center_schedules" ("id" integer NOT NULL, "center_program_id" integer NOT NULL, "started_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_d878434425ba6f75275aff83cdd" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_10628a03a34121e94abaca5c7d" ON "center_schedules" ("center_program_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "assessments" ("id" integer NOT NULL, "center_schedule_id" integer NOT NULL, "result_id" integer, "applied_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_a3442bd80a00e9111cefca57f6c" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_8d714e8885410de2fba4599ad1" ON "assessments" ("center_schedule_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "enrollments" ("id" integer NOT NULL, "training_schedule_id" integer, "train_status_id" integer, "train_result_id" integer, "scholarship_type_id" integer, "created_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_7c0f752f9fb68bf6ed7367ab00f" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_a8e683f4ec73be1353dcc1b6e3" ON "enrollments" ("created_at") `);
    await queryRunner.query(
      `CREATE TYPE "public"."area_level" AS ENUM('NATIONAL', 'REGION', 'PROVINCE', 'CITY')`,
    );
    await queryRunner.query(
      `CREATE TABLE "bsrs_stats" ("id" SERIAL NOT NULL, "level" "public"."area_level" NOT NULL, "source_name" character varying NOT NULL, "region_psgc" character(10), "province_psgc" character(10), "city_key" character varying, "city_keys" text array NOT NULL DEFAULT '{}', "enrolled" integer NOT NULL, "completed" integer NOT NULL, "completion_rate" double precision NOT NULL, "period_label" character varying NOT NULL DEFAULT 'cumulative', CONSTRAINT "PK_2961978cbb8b3acc9126cc4cc97" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_44c8fdd043c91256c75f66f1c2" ON "bsrs_stats" ("province_psgc") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_2538cada48c6ef09366f3d205d" ON "bsrs_stats" ("level", "region_psgc") `,
    );
    await queryRunner.query(
      `CREATE TABLE "bsrs_qualification_stats" ("id" SERIAL NOT NULL, "region_name" character varying NOT NULL, "province_name" character varying NOT NULL, "city_name" character varying NOT NULL, "qualification" character varying NOT NULL, "qualification_id" integer, "enrolled" integer NOT NULL, "completed" integer NOT NULL, CONSTRAINT "PK_9bb251928e9b41e172d8f598327" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "labor_demand" ("id" SERIAL NOT NULL, "region_psgc" character(10), "province_psgc" character(10), "sector" character varying NOT NULL, "vacancies" integer NOT NULL, "period_start" TIMESTAMP WITH TIME ZONE NOT NULL, "source" character varying NOT NULL, CONSTRAINT "PK_d1b4aa415dca4580c3c2df719a9" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_8dd58a6fad10a31551e3b98f52" ON "labor_demand" ("region_psgc", "province_psgc") `,
    );
    await queryRunner.query(`CREATE TYPE "public"."role" AS ENUM('CO', 'RO', 'PO')`);
    await queryRunner.query(
      `CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "email" character varying NOT NULL, "name" character varying NOT NULL, "password_hash" character varying, "t2mis_user_id" character varying, "role" "public"."role" NOT NULL, "region_psgc" character(10), "province_psgc" character(10), "is_active" boolean NOT NULL DEFAULT true, "last_login_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "UQ_2dcfc42deb3794913436f271a80" UNIQUE ("t2mis_user_id"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE TYPE "public"."period" AS ENUM('CURRENT', 'NEXT_QUARTER')`);
    await queryRunner.query(`CREATE TYPE "public"."run_status" AS ENUM('RUNNING', 'COMPLETED', 'FAILED')`);
    await queryRunner.query(
      `CREATE TABLE "simulation_runs" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "period" "public"."period" NOT NULL, "status" "public"."run_status" NOT NULL DEFAULT 'RUNNING', "limit_minutes" integer NOT NULL, "limit_km" integer NOT NULL, "default_slots" integer NOT NULL, "travel_model" character varying NOT NULL, "summary" jsonb, "error" text, "triggered_by" character varying, "started_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "finished_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_e721bc4d4fe17be8cab15c245e9" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_6b23d601993901a3b3652674e9" ON "simulation_runs" ("period", "status", "finished_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "area_utilization" ("id" SERIAL NOT NULL, "run_id" uuid NOT NULL, "level" "public"."area_level" NOT NULL, "area_key" character varying NOT NULL, "parent_key" character varying, "candidates" integer NOT NULL, "flagged" integer NOT NULL, "slots" integer NOT NULL, "used" integer NOT NULL, "centers" integer NOT NULL, "rate" double precision, "flagged_share" double precision NOT NULL, CONSTRAINT "UQ_7e4464bb59f9f5ccda66d06a509" UNIQUE ("run_id", "level", "area_key"), CONSTRAINT "PK_d94bb834e96b9637fcde12e3bd8" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_664d4caab22699fb76196856c9" ON "area_utilization" ("run_id", "level", "parent_key") `,
    );
    await queryRunner.query(
      `CREATE TABLE "center_utilization" ("run_id" uuid NOT NULL, "center_id" integer NOT NULL, "slots" integer NOT NULL, "taken" integer NOT NULL, "demand" integer NOT NULL, "rate" double precision NOT NULL, CONSTRAINT "PK_fac907b7bf6656771b475c91b05" PRIMARY KEY ("run_id", "center_id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "provinces" ADD CONSTRAINT "FK_f21a1a9a90933151c762127ed50" FOREIGN KEY ("region_psgc") REFERENCES "regions"("psgc") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cities" ADD CONSTRAINT "FK_df04d69306c28bee2afdc021673" FOREIGN KEY ("province_psgc") REFERENCES "provinces"("psgc") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "assessment_centers" ADD CONSTRAINT "FK_b76b7b4ed2ba5a58e6319e4c695" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "center_programs" ADD CONSTRAINT "FK_a4bdc96cd4b175f6accab14f344" FOREIGN KEY ("center_id") REFERENCES "assessment_centers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "center_programs" ADD CONSTRAINT "FK_3c2cfc6dd27ca8bb7377840bf9b" FOREIGN KEY ("qualification_id") REFERENCES "qualifications"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "center_schedules" ADD CONSTRAINT "FK_10628a03a34121e94abaca5c7d3" FOREIGN KEY ("center_program_id") REFERENCES "center_programs"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "assessments" ADD CONSTRAINT "FK_8d714e8885410de2fba4599ad15" FOREIGN KEY ("center_schedule_id") REFERENCES "center_schedules"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "area_utilization" ADD CONSTRAINT "FK_941987bae9be5465deb7b049442" FOREIGN KEY ("run_id") REFERENCES "simulation_runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "center_utilization" ADD CONSTRAINT "FK_18816a3a3b13069b5a426f2cc31" FOREIGN KEY ("run_id") REFERENCES "simulation_runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "center_utilization" ADD CONSTRAINT "FK_393121d55ae57067f387cfae933" FOREIGN KEY ("center_id") REFERENCES "assessment_centers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    // spatial indexes (PostGIS)
    await queryRunner.query(`CREATE INDEX "IDX_regions_geom" ON "regions" USING GIST ("geom")`);
    await queryRunner.query(`CREATE INDEX "IDX_provinces_geom" ON "provinces" USING GIST ("geom")`);
    await queryRunner.query(`CREATE INDEX "IDX_cities_geom" ON "cities" USING GIST ("geom")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_cities_centroid_geog" ON "cities" USING GIST (("centroid"::geography))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_centers_location_geog" ON "assessment_centers" USING GIST (("location"::geography))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_cities_name_lower" ON "cities" (lower("name"))`);
    await queryRunner.query(`CREATE INDEX "IDX_users_region" ON "users" ("region_psgc")`);
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "CHK_users_scope" CHECK (("role" = 'CO') OR ("role" = 'RO' AND "region_psgc" IS NOT NULL) OR ("role" = 'PO' AND "region_psgc" IS NOT NULL AND "province_psgc" IS NOT NULL))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "CHK_users_scope"`);
    for (const idx of [
      'IDX_regions_geom',
      'IDX_provinces_geom',
      'IDX_cities_geom',
      'IDX_cities_centroid_geog',
      'IDX_centers_location_geog',
      'IDX_cities_name_lower',
      'IDX_users_region',
    ]) {
      await queryRunner.query(`DROP INDEX IF EXISTS "public"."${idx}"`);
    }
    await queryRunner.query(
      `ALTER TABLE "center_utilization" DROP CONSTRAINT "FK_393121d55ae57067f387cfae933"`,
    );
    await queryRunner.query(
      `ALTER TABLE "center_utilization" DROP CONSTRAINT "FK_18816a3a3b13069b5a426f2cc31"`,
    );
    await queryRunner.query(
      `ALTER TABLE "area_utilization" DROP CONSTRAINT "FK_941987bae9be5465deb7b049442"`,
    );
    await queryRunner.query(`ALTER TABLE "assessments" DROP CONSTRAINT "FK_8d714e8885410de2fba4599ad15"`);
    await queryRunner.query(
      `ALTER TABLE "center_schedules" DROP CONSTRAINT "FK_10628a03a34121e94abaca5c7d3"`,
    );
    await queryRunner.query(`ALTER TABLE "center_programs" DROP CONSTRAINT "FK_3c2cfc6dd27ca8bb7377840bf9b"`);
    await queryRunner.query(`ALTER TABLE "center_programs" DROP CONSTRAINT "FK_a4bdc96cd4b175f6accab14f344"`);
    await queryRunner.query(
      `ALTER TABLE "assessment_centers" DROP CONSTRAINT "FK_b76b7b4ed2ba5a58e6319e4c695"`,
    );
    await queryRunner.query(`ALTER TABLE "cities" DROP CONSTRAINT "FK_df04d69306c28bee2afdc021673"`);
    await queryRunner.query(`ALTER TABLE "provinces" DROP CONSTRAINT "FK_f21a1a9a90933151c762127ed50"`);
    await queryRunner.query(`DROP TABLE "center_utilization"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_664d4caab22699fb76196856c9"`);
    await queryRunner.query(`DROP TABLE "area_utilization"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_6b23d601993901a3b3652674e9"`);
    await queryRunner.query(`DROP TABLE "simulation_runs"`);
    await queryRunner.query(`DROP TYPE "public"."run_status"`);
    await queryRunner.query(`DROP TYPE "public"."period"`);
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TYPE "public"."role"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_8dd58a6fad10a31551e3b98f52"`);
    await queryRunner.query(`DROP TABLE "labor_demand"`);
    await queryRunner.query(`DROP TABLE "bsrs_qualification_stats"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_2538cada48c6ef09366f3d205d"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_44c8fdd043c91256c75f66f1c2"`);
    await queryRunner.query(`DROP TABLE "bsrs_stats"`);
    await queryRunner.query(`DROP TYPE "public"."area_level"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_a8e683f4ec73be1353dcc1b6e3"`);
    await queryRunner.query(`DROP TABLE "enrollments"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_8d714e8885410de2fba4599ad1"`);
    await queryRunner.query(`DROP TABLE "assessments"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_10628a03a34121e94abaca5c7d"`);
    await queryRunner.query(`DROP TABLE "center_schedules"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_3c2cfc6dd27ca8bb7377840bf9"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_a4bdc96cd4b175f6accab14f34"`);
    await queryRunner.query(`DROP TABLE "center_programs"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_e952ec143a3714ed1defa92b2b"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_cd795bd968969d1f5bb0137552"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_4395f9c98c1d1f63eee3e11367"`);
    await queryRunner.query(`DROP TABLE "assessment_centers"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_172413323c5498c9cf2edd861e"`);
    await queryRunner.query(`DROP TABLE "qualifications"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_dc558d5cf8a55656e805a49d2d"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_df04d69306c28bee2afdc02167"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_8714a17ea20e41fd4f61e4a8c9"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_5c147d7fa47d3d11ab09435322"`);
    await queryRunner.query(`DROP TABLE "cities"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_f21a1a9a90933151c762127ed5"`);
    await queryRunner.query(`DROP TABLE "provinces"`);
    await queryRunner.query(`DROP TABLE "regions"`);
  }
}
