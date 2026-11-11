import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { nowEpoch } from '../database/epoch';
import { TesdaCenter, TesdaCenterQualification, TesdaClient } from './tesda.client';

/**
 * Team C's hand corrections of a center's position. The TESDA API still has the raw (wrong) point for these
 * (in the sea, in the next province), so the corrected one is kept.
 */
const KEEP_LOCAL_COORDS = ['geocode_override', 'water_fixed_geocode'];
/** A point that moved less than this (degrees, about 11 m) is the same point, rounded differently. */
const SAME_POINT_DEG = 1e-4;
/** Refuse a pull that would drop more than half of the listed centers: that is an API problem, not a closure wave. */
const MIN_SHARE_OF_LISTED = 0.5;
/** Refuse a students pull that would leave fewer than this share of the graduates stored now: an API problem. */
const MIN_SHARE_OF_GRADUATES = 0.5;

/** City for a point: the polygon containing it, else the nearest within 0.05 degrees (as the ETL does). */
const CITY_OF_POINT_SQL = (point: string) => `
  SELECT ci.id, ci.province_psgc, ci.region_psgc, ci.island_id FROM cities ci
   WHERE ST_DWithin(ci.geom, ${point}, 0.05)
   ORDER BY ST_Contains(ci.geom, ${point}) DESC, ci.geom <-> ${point} LIMIT 1`;

export interface TesdaSyncStats {
  centers: number;
  newCenters: number;
  moved: number;
  keptCorrectedPosition: number;
  delisted: number;
  inAnalysis: number;
  skippedRows: number;
  qualifications: number;
  /** set when the qualification lists could not be pulled; the previous ones were kept */
  qualificationsError?: string;
  graduates: UpcomingGraduatesStats | { skipped: string };
}

export interface UpcomingGraduatesStats {
  /** the API's total of upcoming graduates */
  total: number;
  /** placed in a town */
  inTown: number;
  /** only the province is known */
  provinceOnly: number;
  /** no usable point, qualification or month, or a point in no province */
  notPlaced: number;
}

@Injectable()
export class TesdaSyncService {
  private readonly logger = new Logger(TesdaSyncService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService,
  ) {}

  private client() {
    return new TesdaClient(this.config.get<string>('TESDA_API_URL', 'https://sap-sis.tesda.gov.ph'), {
      apiKey: this.config.get<string>('TESDA_API_KEY'),
      timeoutMs: this.config.get<number>('TESDA_API_TIMEOUT_MS', 20000),
    });
  }

  /** Last completed sync, for "data as of" labels. */
  async lastCompleted(): Promise<{ finishedAt: number; tesdaRunAt: number | null } | null> {
    const [r] = await this.db.query(
      `SELECT finished_at, tesda_run_at FROM tesda_syncs WHERE status = 'COMPLETED' ORDER BY id DESC LIMIT 1`,
    );
    return r ? { finishedAt: Number(r.finished_at), tesdaRunAt: r.tesda_run_at === null ? null : Number(r.tesda_run_at) } : null;
  }

  /**
   * Pull centers, their qualifications and the upcoming graduates (students list) from the TESDA API. One sync at a time.
   * TESDA recalculates once a night: when its run time (GET /coverage/run, needs the key) is the one the last
   * completed sync loaded, the database already has that data and nothing more is requested. `force` pulls anyway.
   */
  sync(triggeredBy: string, force = false): Promise<TesdaSyncStats | { skipped: string; tesdaRunAt: number }> {
    if (this.running) return this.running;
    this.running = this.doSync(triggeredBy, force).finally(() => (this.running = null));
    return this.running;
  }

  private running: Promise<TesdaSyncStats | { skipped: string; tesdaRunAt: number }> | null = null;

  private async doSync(triggeredBy: string, force: boolean): Promise<TesdaSyncStats | { skipped: string; tesdaRunAt: number }> {
    const api = this.client();
    const tesdaRunAt = api.hasKey ? await api.lastRun().catch(() => null) : null;
    const last = await this.lastCompleted();
    if (!force && tesdaRunAt !== null && last?.tesdaRunAt === tesdaRunAt) {
      this.logger.log(`TESDA data unchanged since the last sync (TESDA run ${new Date(tesdaRunAt * 1000).toISOString()}); nothing pulled`);
      return { skipped: 'TESDA has not recalculated since the last sync', tesdaRunAt };
    }
    const [{ id: syncId }] = await this.db.query(
      `INSERT INTO tesda_syncs (status, triggered_by) VALUES ('RUNNING', $1) RETURNING id`,
      [triggeredBy],
    );
    try {
      const pulled = await api.centers();
      const [{ listed }] = await this.db.query(`SELECT count(*) FILTER (WHERE tesda_listed)::int AS listed FROM assessment_centers`);
      if (!pulled.centers.length || pulled.centers.length < listed * MIN_SHARE_OF_LISTED) {
        throw new Error(
          `TESDA API returned ${pulled.centers.length} usable centers (of ${pulled.total}) but ${listed} are listed now; nothing changed`,
        );
      }
      let quals: Map<number, TesdaCenterQualification[]> | null = null;
      let qualificationsError: string | undefined;
      try {
        quals = await api.centerQualifications();
      } catch (e) {
        qualificationsError = (e as Error).message;
        this.logger.warn(`TESDA qualifications not refreshed, keeping the previous ones: ${qualificationsError}`);
      }
      const centerStats = await this.db.transaction((m) => this.applyCenters(m, pulled.centers, quals));
      let graduates: UpcomingGraduatesStats | { skipped: string };
      try {
        graduates = await this.syncGraduates(api);
      } catch (e) {
        graduates = { skipped: (e as Error).message };
        this.logger.warn(`TESDA students not refreshed, keeping the previous graduates: ${graduates.skipped}`);
      }
      const stats: TesdaSyncStats = {
        ...centerStats,
        skippedRows: pulled.skipped,
        ...(qualificationsError ? { qualificationsError } : {}),
        graduates,
      };
      await this.db.query(
        `UPDATE tesda_syncs SET status = 'COMPLETED', finished_at = $2, tesda_run_at = $3, stats = $4 WHERE id = $1`,
        [syncId, nowEpoch(), tesdaRunAt, JSON.stringify(stats)],
      );
      this.logger.log(
        `TESDA sync: ${stats.centers} centers (${stats.newCenters} new, ${stats.delisted} no longer listed), ${stats.inAnalysis} in the analysis, ` +
          `${stats.qualifications} center qualifications` +
          ('total' in graduates
            ? `, ${graduates.inTown + graduates.provinceOnly} of ${graduates.total} upcoming graduates placed`
            : `; graduates skipped: ${graduates.skipped}`),
      );
      return stats;
    } catch (e) {
      await this.db.query(`UPDATE tesda_syncs SET status = 'FAILED', finished_at = $2, error = $3 WHERE id = $1`, [
        syncId,
        nowEpoch(),
        (e as Error).message,
      ]);
      throw e;
    }
  }

  private async applyCenters(m: EntityManager, centers: TesdaCenter[], quals: Map<number, TesdaCenterQualification[]> | null) {
    const now = nowEpoch();
    const col = <K extends keyof TesdaCenter>(k: K) => centers.map((c) => c[k]);
    await m.query(
      `CREATE TEMP TABLE tesda_centers ON COMMIT DROP AS
       SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
                            $9::text[], $10::float8[], $11::float8[], $12::bigint[])
              AS t(id, name, address, city, province, region, phone, email, website, lat, lon, accredited_until)`,
      [
        col('id'), col('name'), col('address'), col('city'), col('province'), col('region'), col('phone'),
        col('email'), col('website'), col('lat'), col('lon'), col('accreditedUntil'),
      ],
    );

    // Which centers need their city/province/island worked out again: new ones, and those whose point moved.
    await m.query(
      `CREATE TEMP TABLE tesda_moved ON COMMIT DROP AS
       SELECT t.id, a.id IS NULL AS is_new FROM tesda_centers t LEFT JOIN assessment_centers a ON a.id = t.id
        WHERE a.id IS NULL
           OR (a.coord_status <> ALL($1::text[]) AND (abs(a.lat - t.lat) > $2 OR abs(a.lon - t.lon) > $2))`,
      [KEEP_LOCAL_COORDS, SAME_POINT_DEG],
    );
    const [{ kept }] = await m.query(
      `SELECT count(*)::int AS kept FROM tesda_centers t JOIN assessment_centers a ON a.id = t.id
        WHERE a.coord_status = ANY($1::text[]) AND (abs(a.lat - t.lat) > $2 OR abs(a.lon - t.lon) > $2)`,
      [KEEP_LOCAL_COORDS, SAME_POINT_DEG],
    );

    await m.query(
      `INSERT INTO assessment_centers (id, name, address, phone, email, website, source_region_name, source_province_name,
              source_city_name, lat, lon, coord_status, coord_source, is_foreign, is_closed, is_hidden, include_in_analysis,
              accredited_until, tesda_listed, synced_at)
       SELECT t.id, t.name, t.address, t.phone, t.email, t.website, t.region, t.province, t.city, t.lat, t.lon,
              'tesda_api', 'tesda_api', false, false, false, false, t.accredited_until, true, $1
         FROM tesda_centers t JOIN tesda_moved mv ON mv.id = t.id AND mv.is_new`,
      [now],
    );
    // Listed by TESDA = open and public, whatever the older T2MIS extract said (BARMM centers were "Hidden" there).
    await m.query(
      `UPDATE assessment_centers a
          SET name = t.name, address = t.address, phone = t.phone, email = t.email, website = t.website,
              source_region_name = t.region, source_province_name = t.province, source_city_name = t.city,
              accredited_until = t.accredited_until, tesda_listed = true, synced_at = $1, is_hidden = false, is_closed = false,
              lat = CASE WHEN mv.id IS NULL THEN a.lat ELSE t.lat END,
              lon = CASE WHEN mv.id IS NULL THEN a.lon ELSE t.lon END,
              coord_status = CASE WHEN mv.id IS NULL THEN a.coord_status ELSE 'tesda_api' END,
              coord_source = CASE WHEN mv.id IS NULL THEN a.coord_source ELSE 'tesda_api' END
         FROM tesda_centers t LEFT JOIN tesda_moved mv ON mv.id = t.id AND NOT mv.is_new
        WHERE a.id = t.id`,
      [now],
    );
    await m.query(
      `UPDATE assessment_centers a SET location = ST_SetSRID(ST_MakePoint(a.lon, a.lat), 4326)
        WHERE a.id IN (SELECT id FROM tesda_moved)`,
    );
    await m.query(
      `UPDATE assessment_centers a
          SET city_id = c.id, province_psgc = c.province_psgc, region_psgc = c.region_psgc, island_id = c.island_id
         FROM assessment_centers x LEFT JOIN LATERAL (${CITY_OF_POINT_SQL('x.location')}) c ON true
        WHERE x.id = a.id AND a.id IN (SELECT id FROM tesda_moved)`,
    );
    const [{ delisted }] = await m.query(
      `WITH d AS (UPDATE assessment_centers a SET tesda_listed = false
                   WHERE a.tesda_listed IS DISTINCT FROM false AND NOT EXISTS (SELECT 1 FROM tesda_centers t WHERE t.id = a.id)
                   RETURNING 1)
       SELECT count(*)::int AS delisted FROM d`,
    );
    // The analysis uses TESDA's list only. A listed center with no province (point at sea) stays out until
    // `npm run data:quality -- --apply` can place it.
    await m.query(
      `UPDATE assessment_centers SET include_in_analysis = (tesda_listed AND NOT is_foreign AND province_psgc IS NOT NULL)`,
    );

    // Qualifications: replaced as a whole, only for centers in this pull (an unlisted id is ignored).
    const listed = new Set(centers.map((c) => c.id));
    const qc: number[] = [];
    const qn: string[] = [];
    const qu: Array<number | null> = [];
    for (const [id, list] of quals ?? [])
      for (const q of list) {
        if (!listed.has(id)) continue;
        qc.push(id);
        qn.push(q.qualification);
        qu.push(q.accreditedUntil);
      }
    if (quals) await m.query(`DELETE FROM center_qualifications`);
    if (quals) await m.query(
      `INSERT INTO center_qualifications (center_id, qualification, accredited_until)
       SELECT u.center_id, u.qualification, u.accredited_until
         FROM unnest($1::int[], $2::text[], $3::bigint[]) AS u(center_id, qualification, accredited_until)
       ON CONFLICT DO NOTHING`,
      [qc, qn, qu],
    );

    const [counts] = await m.query(
      `SELECT (SELECT count(*) FROM tesda_moved WHERE is_new)::int AS new_centers,
              (SELECT count(*) FROM tesda_moved WHERE NOT is_new)::int AS moved,
              (SELECT count(*) FROM assessment_centers WHERE include_in_analysis)::int AS in_analysis,
              (SELECT count(*) FROM center_qualifications)::int AS qualifications`,
    );
    return {
      centers: centers.length,
      newCenters: counts.new_centers,
      moved: counts.moved,
      keptCorrectedPosition: kept,
      delisted,
      inAnalysis: counts.in_analysis,
      qualifications: counts.qualifications,
    };
  }

  /**
   * Upcoming graduates from the students list, replaced as a whole. The client has already summed the rows per point,
   * qualification and month; here each point goes to its town (or only its province when that is all the API knows),
   * and the sums per town/province, qualification and month are stored. A failure, or a pull that would drop more than
   * half the graduates stored now, leaves the old figures.
   */
  private async syncGraduates(api: TesdaClient): Promise<UpcomingGraduatesStats> {
    const pulled = await api.upcomingGraduates();
    const g = pulled.groups;
    const placedGraduates = g.reduce((n, x) => n + x.graduates, 0);
    return this.db.transaction(async (m) => {
      const [{ now }] = await m.query(`SELECT coalesce(sum(graduates), 0)::int AS now FROM upcoming_graduates`);
      if (!placedGraduates || placedGraduates < now * MIN_SHARE_OF_GRADUATES) {
        throw new Error(`TESDA API returned ${placedGraduates} usable graduates but ${now} are stored now; nothing changed`);
      }
      await m.query(`DELETE FROM upcoming_graduates`);
      await m.query(
        `INSERT INTO upcoming_graduates (province_psgc, city_id, qualification, finish_month, graduates)
         SELECT c.province_psgc, CASE WHEN u.precision = 'city' THEN c.id END, min(u.qualification), u.month, sum(u.graduates)
           FROM unnest($1::float8[], $2::float8[], $3::text[], $4::text[], $5::bigint[], $6::int[])
                AS u(lat, lon, precision, qualification, month, graduates)
           JOIN LATERAL (${CITY_OF_POINT_SQL('ST_SetSRID(ST_MakePoint(u.lon, u.lat), 4326)')}) c ON true
          GROUP BY c.province_psgc, CASE WHEN u.precision = 'city' THEN c.id END, lower(u.qualification), u.month`,
        [g.map((x) => x.lat), g.map((x) => x.lon), g.map((x) => x.precision), g.map((x) => x.qualification), g.map((x) => x.month), g.map((x) => x.graduates)],
      );
      const [r] = await m.query(
        `SELECT coalesce(sum(graduates) FILTER (WHERE city_id IS NOT NULL), 0)::int AS in_town,
                coalesce(sum(graduates) FILTER (WHERE city_id IS NULL), 0)::int AS province_only
           FROM upcoming_graduates`,
      );
      return {
        total: pulled.total,
        inTown: r.in_town,
        provinceOnly: r.province_only,
        notPlaced: pulled.skipped + placedGraduates - r.in_town - r.province_only,
      };
    });
  }
}
