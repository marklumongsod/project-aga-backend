import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Monthly assessment-candidate forecasts.
 *
 * The Python/LightGBM job runs outside the API and writes aggregate JSON. `forecast_runs` records one import;
 * `forecast_values` holds the six monthly rows per place after mapping to PSGC/center. `forecast_places` is the
 * raw T2MIS place -> backend area mapping, including historical/split/overseas cases.
 *
 * `forecast_real` is stored at the raw model value and `share` is applied when the API sums a split place.
 */
export class Forecast1792600000025 implements MigrationInterface {
  name = 'Forecast1792600000025';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "forecast_runs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "forecast_month" bigint NOT NULL,
        "generated_at" bigint NOT NULL,
        "imported_at" bigint NOT NULL DEFAULT (FLOOR(EXTRACT(EPOCH FROM now())))::bigint,
        "model_version" character varying NOT NULL,
        "sample_rate" double precision NOT NULL DEFAULT 0.2,
        "row_count" integer NOT NULL,
        "source_file" character varying,
        "metadata" jsonb,
        CONSTRAINT "PK_forecast_runs" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_forecast_runs" UNIQUE ("forecast_month", "model_version")
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_forecast_runs_month" ON "forecast_runs" ("forecast_month")`);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "forecast_places" (
        "id" SERIAL NOT NULL,
        "level" character varying NOT NULL,
        "source_place_id" character varying NOT NULL,
        "parent_source_id" character varying,
        "name" character varying,
        "target_type" character varying NOT NULL,
        "target_code" character varying NOT NULL,
        "share" double precision NOT NULL DEFAULT 1,
        "note" character varying,
        CONSTRAINT "PK_forecast_places" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_forecast_places" UNIQUE ("level", "source_place_id", "target_type", "target_code"),
        CONSTRAINT "CHK_forecast_places_share" CHECK ("share" >= 0 AND "share" <= 1)
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_forecast_places_source" ON "forecast_places" ("level", "source_place_id")`,
    );

    await q.query(`
      CREATE TABLE IF NOT EXISTS "forecast_values" (
        "id" BIGSERIAL NOT NULL,
        "run_id" uuid NOT NULL,
        "level" character varying NOT NULL,
        "source_place_id" character varying NOT NULL,
        "parent_source_id" character varying,
        "target_type" character varying NOT NULL,
        "target_code" character varying NOT NULL,
        "target_month" bigint NOT NULL,
        "horizon" smallint NOT NULL,
        "forecast_sample" double precision NOT NULL,
        "forecast_real" double precision NOT NULL,
        "share" double precision NOT NULL DEFAULT 1,
        "region_psgc" character(10),
        "province_psgc" character(10),
        "center_id" integer,
        CONSTRAINT "PK_forecast_values" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_forecast_values_horizon" CHECK ("horizon" >= 1 AND "horizon" <= 6),
        CONSTRAINT "CHK_forecast_values_share" CHECK ("share" >= 0 AND "share" <= 1),
        CONSTRAINT "UQ_forecast_values" UNIQUE (
          "run_id", "level", "source_place_id", "target_month", "horizon", "target_type", "target_code"
        ),
        CONSTRAINT "FK_forecast_values_run" FOREIGN KEY ("run_id") REFERENCES "forecast_runs"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_forecast_values_center" FOREIGN KEY ("center_id") REFERENCES "assessment_centers"("id") ON DELETE SET NULL
      )
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_forecast_values_region" ON "forecast_values" ("run_id", "level", "region_psgc", "target_month")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_forecast_values_province" ON "forecast_values" ("run_id", "level", "province_psgc", "target_month")`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_forecast_values_center" ON "forecast_values" ("run_id", "level", "center_id", "target_month")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "forecast_values"`);
    await q.query(`DROP TABLE IF EXISTS "forecast_places"`);
    await q.query(`DROP TABLE IF EXISTS "forecast_runs"`);
  }
}
