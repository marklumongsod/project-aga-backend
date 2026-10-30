import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { haversineKm } from '../../common/geo/haversine';
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
  async build(client: OsrmClient, onProgress?: (done: number, total: number) => void) {
    const limitKm = Math.ceil((this.config.get<number>('SIM_LIMIT_MINUTES', 90) / 60) * this.config.get<number>('SIM_MAX_SPEED_KMH', 75));
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
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        const part = rows.slice(i, i + INSERT_BATCH);
        await tx.query(
          `INSERT INTO travel_times (city_key, center_id, minutes, road_km)
           SELECT * FROM unnest($1::text[], $2::int[], $3::real[], $4::real[])`,
          [part.map((r) => r[0]), part.map((r) => r[1]), part.map((r) => r[2]), part.map((r) => r[3])],
        );
      }
    });
    await this.reload();
    return { cities: cities.length, centers: centers.length, pairs, routed: rows.length, unrouted };
  }
}
