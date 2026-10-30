import { MigrationInterface, QueryRunner } from 'typeorm';

/** Road + ferry minutes per (city, center) pair within the km limit, filled by `npm run travel:build` from OSRM. */
export class TravelTimes1792600000001 implements MigrationInterface {
  name = 'TravelTimes1792600000001';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "travel_times" (
         "city_key" character varying NOT NULL,
         "center_id" integer NOT NULL,
         "minutes" real NOT NULL,
         "road_km" real,
         "computed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "PK_travel_times" PRIMARY KEY ("city_key", "center_id")
       )`,
    );
    await q.query(`CREATE INDEX "IDX_travel_times_center" ON "travel_times" ("center_id")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "travel_times"`);
  }
}
