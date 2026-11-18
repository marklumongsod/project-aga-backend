import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { haversineKm } from '../../common/geo/haversine';
import { CenterPoint } from './changed-centers';
import { MatrixTravelTimeModel, pairKey } from './matrix-travel-time.model';
import { OsrmClient } from './osrm.client';
import { TRAVEL_TIME_MODEL } from './travel-time.model';

const GRID = 0.25; // degrees, same idea as the engine's index
const INSERT_BATCH = 5000;
const CONCURRENCY = 4;

/** Loads the precomputed (city, center) travel-time matrix into the model, and builds it from OSRM. */
@Injectable()
export class TravelMatrixService implements OnModuleInit {
  private readonly log = new Logger(TravelMatrixService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService,
    @Inject(TRAVEL_TIME_MODEL) private readonly model: MatrixTravelTimeModel,
  ) {}

  get mode() {
    return this.config.get<string>('TRAVEL_MODEL', 'estimate');
  }

  async onModuleInit() {
    await this.reload();
  }

  /** (Re)load the matrix from the database. Only used when TRAVEL_MODEL=osrm; otherwise the estimate applies. */
  async reload(): Promise<void> {
    if (this.mode !== 'osrm') {
      this.model.setMatrix(new Map());
      return;
    }
    const rows: Array<{ city_key: string; center_id: number; minutes: number; computed_at: string }> =
      await this.db.query(`SELECT city_key, center_id, minutes, computed_at FROM travel_times`);
    const matrix = new Map<string, number>();
    let latest: number | null = null; // newest computed_at, epoch seconds
    for (const r of rows) {
      matrix.set(pairKey(r.city_key, r.center_id), r.minutes);
      const at = Number(r.computed_at);
      if (latest === null || at > latest) latest = at;
    }
    this.model.setMatrix(matrix, latest === null ? null : new Date(latest * 1000));
    if (!matrix.size) this.log.warn('TRAVEL_MODEL=osrm but travel_times is empty: run `npm run travel:build`. Using the estimate.');
    else this.log.log(`travel matrix loaded: ${matrix.size} city-center pairs`);
  }

  /**
   * Ask OSRM for the road + ferry time from every city to every center within the search radius (how far anything
   * could be in the travel limit at the fastest road pace: ~112 km for 90 minutes), then replace the table in one
   * transaction. Pairs beyond it are never in reach, so the simulation never looks at them.
   */
  /** Straight-line radius past which nothing can be in reach (travel limit at the fastest road pace). */
  private searchKm() {
    return Math.ceil((this.config.get<number>('SIM_LIMIT_MINUTES', 90) / 60) * this.config.get<number>('SIM_MAX_SPEED_KMH', 75));
  }

  /** Centers in the analysis now, with their points, for the monthly job's before/after comparison. */
  centerPoints(): Promise<CenterPoint[]> {
    return this.db.query(`SELECT id, lat, lon FROM assessment_centers WHERE include_in_analysis ORDER BY id`);
  }

  /** Ids of centers that have at least one row in travel_times. */
  async routedCenterIds(): Promise<Set<number>> {
    const rows: Array<{ center_id: number }> = await this.db.query(`SELECT DISTINCT center_id FROM travel_times`);
    return new Set(rows.map((r) => r.center_id));
  }

  /**
   * Route only these centers: for each, ask OSRM for the time from every city within the search radius to it, then
   * replace just their rows (one transaction). Rows of centers that left the analysis are dropped too. The rest of
   * the matrix is kept, so this takes seconds where `build()` re-routes the whole country.
   */
  async refreshCenters(client: OsrmClient, centerIds: number[]) {
    const limitKm = this.searchKm();
    const centers: Array<{ id: number; lat: number; lon: number }> = centerIds.length
      ? await this.db.query(`SELECT id, lat, lon FROM assessment_centers WHERE include_in_analysis AND id = ANY($1::int[]) ORDER BY id`, [centerIds])
      : [];
    const rows: Array<[string, number, number, number]> = [];
    let pairs = 0;
    let unrouted = 0;
    for (const c of centers) {
      const cities: Array<{ key: string; lat: number; lon: number }> = await this.db.query(
        `SELECT key, lat, lon FROM cities
          WHERE ST_DWithin(centroid::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
          ORDER BY key`,
        // the index is on centroid; routing uses lat/lon (a point inside the town), so search a little wider
        [c.lon, c.lat, (limitKm + 25) * 1000],
      );
      // the same straight-line test build() uses, so both ways of filling the table agree on which pairs exist
      const near = cities.filter((city) => haversineKm(city.lat, city.lon, c.lat, c.lon) <= limitKm);
      if (!near.length) continue;
      const t = await client.table(near, [c]);
      near.forEach((city, i) => {
        pairs++;
        const m = t.minutes[i]![0];
        if (m === null || m === undefined) unrouted++;
        else rows.push([city.key, c.id, Math.round(m * 10) / 10, Math.round((t.km[i]![0] ?? 0) * 10) / 10]);
      });
    }
    // Same guard as build(): a server with the wrong map answers "no route" for everything. Small batches are exempt,
    // since one center on an island without a mapped ferry is legitimately unroutable.
    if (pairs >= 50 && unrouted / pairs > 0.9) {
      throw new Error(`OSRM found a route for only ${pairs - unrouted} of ${pairs} pairs: is the Philippines map loaded?`);
    }

    let dropped = 0;
    await this.db.transaction(async (tx) => {
      if (centers.length) await tx.query(`DELETE FROM travel_times WHERE center_id = ANY($1::int[])`, [centers.map((c) => c.id)]);
      const [d] = await tx.query(
        `WITH d AS (DELETE FROM travel_times t
                     WHERE NOT EXISTS (SELECT 1 FROM assessment_centers a WHERE a.id = t.center_id AND a.include_in_analysis)
                     RETURNING 1)
         SELECT count(*)::int AS n FROM d`,
      );
      dropped = d.n;
      await this.insertRows(tx, rows);
    });
    await this.reload();
    return { centers: centers.length, pairs, routed: rows.length, unrouted, droppedRows: dropped };
  }

  private async insertRows(tx: EntityManager, rows: Array<[string, number, number, number]>) {
    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      const part = rows.slice(i, i + INSERT_BATCH);
      await tx.query(
        `INSERT INTO travel_times (city_key, center_id, minutes, road_km)
         SELECT * FROM unnest($1::text[], $2::int[], $3::real[], $4::real[])`,
        [part.map((r) => r[0]), part.map((r) => r[1]), part.map((r) => r[2]), part.map((r) => r[3])],
      );
    }
  }

  async build(client: OsrmClient, onProgress?: (done: number, total: number) => void) {
    const limitKm = this.searchKm();
    const cities: Array<{ key: string; lat: number; lon: number }> = await this.db.query(
      `SELECT key, lat, lon FROM cities ORDER BY key`,
    );
    const centers: Array<{ id: number; lat: number; lon: number }> = await this.db.query(
      `SELECT id, lat, lon FROM assessment_centers WHERE include_in_analysis ORDER BY id`,
    );
    const grid = new Map<string, typeof centers>();
    const cell = (lat: number, lon: number) => `${Math.floor(lat / GRID)}:${Math.floor(lon / GRID)}`;
    for (const c of centers) {
      const k = cell(c.lat, c.lon);
      grid.get(k)?.push(c) ?? grid.set(k, [c]);
    }
    const span = Math.ceil(limitKm / 111 / GRID) + 1;
    const near = (city: { lat: number; lon: number }) => {
      const out: typeof centers = [];
      const cy = Math.floor(city.lat / GRID);
      const cx = Math.floor(city.lon / GRID);
      for (let y = cy - span; y <= cy + span; y++)
        for (let x = cx - span; x <= cx + span; x++)
          for (const c of grid.get(`${y}:${x}`) ?? []) if (haversineKm(city.lat, city.lon, c.lat, c.lon) <= limitKm) out.push(c);
      return out;
    };

    const rows: Array<[string, number, number, number]> = [];
    let pairs = 0;
    let unrouted = 0;
    let done = 0;
    const queue = [...cities];
    const worker = async () => {
      for (let city = queue.shift(); city; city = queue.shift()) {
        const dests = near(city);
        if (dests.length) {
          const t = await client.table([city], dests);
          dests.forEach((c, j) => {
            pairs++;
            const m = t.minutes[0]![j];
            if (m === null || m === undefined) unrouted++;
            else rows.push([city.key, c.id, Math.round(m * 10) / 10, Math.round((t.km[0]![j] ?? 0) * 10) / 10]);
          });
        }
        onProgress?.(++done, cities.length);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    // A server loaded with the wrong map would answer "no route" for everything; don't wipe a good matrix with that.
    if (pairs === 0 || unrouted / pairs > 0.9) {
      throw new Error(`OSRM found a route for only ${pairs - unrouted} of ${pairs} pairs: is the Philippines map loaded?`);
    }

    await this.db.transaction(async (tx) => {
      await tx.query(`DELETE FROM travel_times`);
      await this.insertRows(tx, rows);
    });
    await this.reload();
    return { cities: cities.length, centers: centers.length, pairs, routed: rows.length, unrouted };
  }
}
