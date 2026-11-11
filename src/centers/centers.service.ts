import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { isoBand, toEpoch } from '../common/rate-band';
import { currentQuarter, parseQuarter } from '../common/quarter';
import { AreaLevel } from '../database/entities';
import { AreaScopeService } from '../scope/area-scope.service';
import { qualificationKey } from '../simulation/qualification-need';
import { SimulationService } from '../simulation/simulation.service';
import { RoutingService } from '../simulation/travel/routing.service';
import { routedIsochrones } from './isochrone';
import { TRAVEL_TIME_MODEL, TravelTimeModel } from '../simulation/travel/travel-time.model';

@Injectable()
export class CentersService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly scope: AreaScopeService,
    private readonly sim: SimulationService,
    @Inject(TRAVEL_TIME_MODEL) private readonly travel: TravelTimeModel,
    private readonly routing: RoutingService,
  ) {}

  private async load(user: AuthUser, id: number) {
    const [c] = await this.db.query(
      `SELECT c.*, ci.name AS city_name, ci.key AS city_key, p.name AS province_name, r.name AS region_name
         FROM assessment_centers c
         LEFT JOIN cities ci ON ci.id = c.city_id
         LEFT JOIN provinces p ON p.psgc = c.province_psgc
         LEFT JOIN regions r ON r.psgc = c.region_psgc
        WHERE c.id = $1`,
      [id],
    );
    if (!c) throw new NotFoundException(`Assessment center ${id} not found`);
    if (c.province_psgc)
      await this.scope.assertAllowed(user, { level: AreaLevel.PROVINCE, code: c.province_psgc, name: '' });
    return c;
  }

  /** Center card: details, accredited qualifications, predicted candidates. */
  async detail(user: AuthUser, id: number, limitMinutes?: number) {
    const c = await this.load(user, id);
    // Qualifications as the TESDA API lists them.
    const programs = await this.db.query(
      `SELECT cq.qualification_id AS id, regexp_replace(cq.qualification, ' (I|II|III|IV)$', ' NC \\1') AS title, q.code,
              cq.accredited_until AS expires_at
         FROM center_qualifications cq LEFT JOIN qualifications q ON q.id = cq.qualification_id
        WHERE cq.center_id = $1 ORDER BY cq.qualification`,
      [id],
    );
    const util = async () => {
      try {
        const run = await this.sim.runFor(limitMinutes);
        const [u] = await this.db.query(`SELECT demand FROM center_utilization WHERE run_id = $1 AND center_id = $2`, [run.id, id]);
        return u ? { predictedCandidates: u.demand } : null;
      } catch {
        return null;
      }
    };
    return {
      id: c.id,
      name: c.name,
      address: c.address,
      phone: c.phone,
      email: c.email,
      website: c.website,
      accreditedUntil: toEpoch(c.accredited_until as string | null),
      /** false = no longer in the TESDA API's center list (kept for older results); null = never synced */
      listedByTesda: c.tesda_listed,
      lat: c.lat,
      lon: c.lon,
      city: c.city_name,
      province: c.province_name,
      region: c.region_name,
      coordStatus: c.coord_status,
      includeInAnalysis: c.include_in_analysis,
      qualifications: programs.map((p: Record<string, unknown>) => ({
        id: p.id,
        title: p.title,
        code: p.code,
        expiresAt: toEpoch(p.expires_at as string | null),
      })),
      current: await util(),
    };
  }

  /**
   * Capacity utilization for every qualification this center offers, for one quarter. Each qualification is a
   * one-off capacity run (nearest center with an open slot); the first call creates the run, later calls reuse it.
   */
  async utilization(user: AuthUser, id: number, limitMinutes?: number, quarterLabel?: string) {
    const c = await this.load(user, id);
    const quarter = quarterLabel ? parseQuarter(quarterLabel) : currentQuarter();
    if (!quarter) throw new BadRequestException('quarter must look like 2026-Q4');
    const programs: Array<{ name: string; id: number | null; title: string; code: string | null }> = await this.db.query(
      `SELECT cq.qualification AS name, cq.qualification_id AS id,
              regexp_replace(cq.qualification, ' (I|II|III|IV)$', ' NC \\1') AS title, q.code
         FROM center_qualifications cq LEFT JOIN qualifications q ON q.id = cq.qualification_id
        WHERE cq.center_id = $1 ORDER BY cq.qualification`,
      [id],
    );
    const slotRows: Array<{ qualification_key: string; slots: number }> = await this.db.query(
      `SELECT qualification_key, sum(slots)::int AS slots
         FROM center_qualification_slots
        WHERE center_id = $1 AND month_start >= $2 AND month_start < $3
        GROUP BY qualification_key`,
      [id, quarter.start, quarter.end],
    );
    const slots = new Map(slotRows.map((r) => [r.qualification_key, r.slots]));
    const limit = limitMinutes ?? this.sim.limits.limitMinutes;
    const seen = new Set<string>();
    const rows: Array<{
      key: string;
      qualificationId: number | null;
      qualification: string;
      slots: number;
      candidates: number | null;
      assigned: number | null;
      utilization: number | null;
      serviceRate: number | null;
    }> = [];
    for (const p of programs) {
      const key = qualificationKey(p.name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const programSlots = slots.get(key) ?? 0;
      let current: { demand: number; assigned: number | null; utilization: number | null; service_rate: number | null } | null = null;
      if (programSlots > 0) {
        try {
          const run = await this.sim.runFor(limit, p.name, quarter.label);
          const [u] = await this.db.query(
            `SELECT demand, assigned, utilization, service_rate FROM center_utilization WHERE run_id = $1 AND center_id = $2`,
            [run.id, id],
          );
          current = u ?? null;
        } catch {
          // No candidates/centers for this qualification in the quarter: still show its slots.
        }
      }
      rows.push({
        key,
        qualificationId: p.id,
        qualification: p.title,
        slots: programSlots,
        candidates: current?.demand ?? null,
        assigned: current?.assigned ?? null,
        utilization: current?.utilization ?? null,
        serviceRate: current?.service_rate ?? null,
      });
    }
    return {
      center: { id: c.id, name: c.name, city: c.city_name, province: c.province_name, region: c.region_name },
      quarter: quarter.label,
      limitMinutes: limit,
      qualifications: rows,
    };
  }

  async reach(user: AuthUser, id: number, limit?: number) {
    const c = await this.load(user, id);
    const limitMinutes = limit ?? this.sim.limits.limitMinutes;
    // look far enough for anything within 1.5x the limit (the outer band); reach itself is decided by road minutes only
    const searchKm = this.sim.searchKm(limitMinutes * 1.5);
    const rows: Array<{ key: string; name: string; island_id: number; lat: number; lon: number; km: number; geometry: string }> =
      await this.db.query(
        `SELECT ci.key, ci.name, ci.island_id, ci.lat, ci.lon,
              ST_Distance(ci.centroid::geography, c.location::geography) / 1000 AS km,
              ST_AsGeoJSON(ST_SimplifyPreserveTopology(ci.geom, 0.0007), 5) AS geometry
         FROM cities ci, assessment_centers c
        WHERE c.id = $1 AND ST_DWithin(ci.centroid::geography, c.location::geography, $2 * 1000)`,
        [id, searchKm],
      );
    // Cities -> this center, one OSRM table call (chunked). null when routing is off/unavailable.
    const live = await this.routing.table(
      rows.map((r) => ({ lon: r.lon, lat: r.lat })),
      [{ lon: c.lon, lat: c.lat }],
    );
    const dest = { id: c.id, lat: c.lat, lon: c.lon, islandId: c.island_id };
    const features = rows
      .map((r, i) => {
        const minutes =
          live?.minutes[i]?.[0] ??
          this.travel.minutes({ key: r.key, lat: r.lat, lon: r.lon, islandId: r.island_id }, dest, r.km);
        return { r, minutes, within: minutes <= limitMinutes };
      })
      .filter((x) => x.minutes <= limitMinutes * 1.5)
      .map(({ r, minutes, within }) => ({
        type: 'Feature' as const,
        id: r.key,
        geometry: JSON.parse(r.geometry),
        properties: {
          key: r.key,
          name: r.name,
          km: Math.round(r.km * 10) / 10,
          minutes: Math.round(minutes),
          withinLimit: within,
          isoBand: isoBand(minutes, limitMinutes),
        },
      }));
    return {
      type: 'FeatureCollection' as const,
      properties: {
        center: { id: c.id, name: c.name, lat: c.lat, lon: c.lon },
        limitMinutes,
        travelModel: live ? this.routing.label : this.travel.name,
        citiesWithinLimit: features.filter((f) => f.properties.withinLimit).length,
      },
      features,
    };
  }

  private readonly isoCache = new Map<string, { at: number; value: unknown }>();

  /**
   * Click a center: true travel-time polygons (isochrones) at 1/3, 2/3 and 1x the travel limit (30 / 60 / 90 minutes),
   * from a grid of points routed to the center by OSRM (road + ferry). Cached for 10 minutes per center.
   * 503 when routing is off: the reach map (cities shaded by estimated time) still works without it.
   */
  async isochrone(user: AuthUser, id: number, limit?: number) {
    const c = await this.load(user, id);
    if (!this.routing.enabled) throw new ServiceUnavailableException('Isochrones need the routing service, which is not enabled on this server');
    const limitMinutes = limit ?? this.sim.limits.limitMinutes;
    const key = `${id}|${limitMinutes}`;
    const hit = this.isoCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;

    // Look as far as anything could be in the limit (search bound), routed by road and ferry.
    const iso = await routedIsochrones({ lon: c.lon, lat: c.lat }, limitMinutes, this.sim.searchKm(limitMinutes), (s, d) => this.routing.table(s, d));
    if (!iso) throw new ServiceUnavailableException('Isochrones are unavailable right now. Try again in a moment.');
    const { radiusKm, spacingKm, built } = iso;

    const value = {
      type: 'FeatureCollection' as const,
      properties: {
        center: { id: c.id, name: c.name, lat: c.lat, lon: c.lon },
        minutes: [limitMinutes / 3, (2 * limitMinutes) / 3, limitMinutes],
        radiusKm,
        spacingKm,
        travelModel: this.routing.label,
        gridPoints: built.points,
        reachedPoints: built.reached,
        samples: built.samples,
      },
      features: iso.features,
    };
    this.isoCache.set(key, { at: Date.now(), value });
    return value;
  }
}
