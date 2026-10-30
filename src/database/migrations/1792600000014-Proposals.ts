import { MigrationInterface, QueryRunner } from 'typeorm';

/** Saved what-ifs ("Save proposal" in the planner). Dates are epoch seconds like every other table. */
export class Proposals1792600000014 implements MigrationInterface {
  name = 'Proposals1792600000014';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "proposals" (
         "id" uuid NOT NULL DEFAULT gen_random_uuid(),
         "author_id" uuid NOT NULL,
         "name" character varying(120) NOT NULL,
         "lat" double precision NOT NULL,
         "lon" double precision NOT NULL,
         "city_key" character varying,
         "city_name" character varying,
         "region_psgc" character(10),
         "province_psgc" character(10),
         "area_level" character varying NOT NULL,
         "area_code" character varying NOT NULL,
         "area_name" character varying NOT NULL,
         "limit_minutes" integer NOT NULL,
         "status" character varying NOT NULL DEFAULT 'SAVED',
         "snapshot" jsonb NOT NULL,
         "created_at" bigint NOT NULL DEFAULT (FLOOR(EXTRACT(EPOCH FROM now())))::bigint,
         CONSTRAINT "PK_proposals" PRIMARY KEY ("id"),
         CONSTRAINT "FK_proposals_author" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE
       )`,
    );
    await q.query(`COMMENT ON COLUMN "proposals"."created_at" IS 'epoch seconds (UTC)'`);
    await q.query(`CREATE INDEX "IDX_proposals_author" ON "proposals" ("author_id")`);
    await q.query(`CREATE INDEX "IDX_proposals_region" ON "proposals" ("region_psgc")`);
    await q.query(`CREATE INDEX "IDX_proposals_province" ON "proposals" ("province_psgc")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "proposals"`);
  }
}
