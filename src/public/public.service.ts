import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SimulationService } from '../simulation/simulation.service';
import { RoutingService } from '../simulation/travel/routing.service';
import { TRAVEL_TIME_MODEL, TravelTimeModel } from '../simulation/travel/travel-time.model';
import { haversineKm } from '../common/geo/haversine';
import { toRouteSteps, WALK_MAX_M, WALK_MAX_ROUTE_KM, walkMinutes, walkSteps } from '../simulation/travel/route-instructions';
import { NearestCentersDto, RouteDto, RouteResultDto } from './public.dto';

/** Centers farther than this are not useful to a learner and are not listed. */
const SEARCH_RADIUS_KM = 150;

const like = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/** A center qualification from the TESDA API ("Cookery II") as the finder shows it ("Cookery NC II"). */
const LABEL = (col: string) => `regexp_replace(${col}, ' (I|II|III|IV)$', ' NC \\1')`;
const ROMAN = (col: string) => `substring(${col} from ' (I|II|III|IV)$')`;

/**
 * Public learner view: no sign-in. Shows assessment centers, their address and contact,
 * qualifications and estimated travel time. Never returns learner data, predicted
 * candidates or congestion figures.
 */
@Injectable()
export class PublicService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly sim: SimulationService,
    @Inject(TRAVEL_TIME_MODEL) private readonly travel: TravelTimeModel,
    private readonly routing: RoutingService,
  ) {}

  /** Search box: cities/municipalities and provinces by name. */
  places(q: string) {
    return this.db.query(
      `SELECT 'CITY' AS type, c.key, c.name, p.name AS province, r.name AS region, c.lat, c.lon
         FROM cities c JOIN provinces p ON p.psgc = c.province_psgc JOIN regions r ON r.psgc = c.region_psgc
        WHERE c.name ILIKE $1 OR p.name ILIKE $1
        ORDER BY (c.name ILIKE $2) DESC, c.name LIMIT 12`,
      [like(q), `${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`],
    );
  }

  /**
   * Qualification filter, from the TESDA API's center qualifications. `centers` = how many listed centers are
   * accredited for it. `id` is the T2MIS QualId when the name matches one, else null: filter by `label` then.
   */
  qualifications(q?: string) {
    return this.db.query(
      `WITH l AS (
         SELECT cq.center_id, cq.qualification_id, ${LABEL('cq.qualification')} AS label, ${ROMAN('cq.qualification')} AS roman,
                regexp_replace(cq.qualification, ' (I|II|III|IV)$', '') AS base
           FROM center_qualifications cq JOIN assessment_centers c ON c.id = cq.center_id AND c.include_in_analysis)
       SELECT max(l.qualification_id) AS id, coalesce(max(q.title), max(l.base)) AS title, max(q.code) AS code,
              coalesce(max(q.level_id), CASE max(l.roman) WHEN 'I' THEN 1 WHEN 'II' THEN 2 WHEN 'III' THEN 3 WHEN 'IV' THEN 4 END) AS "levelId",
              l.label, count(DISTINCT l.center_id)::int AS centers
         FROM l LEFT JOIN qualifications q ON q.id = l.qualification_id
        WHERE ($1::text IS NULL OR l.label ILIKE $1 OR q.code ILIKE $1)
        GROUP BY l.label
        ORDER BY count(DISTINCT l.center_id) DESC, l.label LIMIT 50`,
      [q ? like(q) : null],
    );
  }

  /** Nearest assessment centers by travel time (live OSRM road + ferry when enabled, else the estimate), with optional filters. */
  async nearest(dto: NearestCentersDto) {
    let origin: {
      lat: number;
      lon: number;
      cityKey: string | null;
      cityName: string | null;
      province: string | null;
      islandId: number | null;
    };
    if (dto.cityKey) {
      const [c] = await this.db.query(
        `SELECT c.key, c.name, c.lat, c.lon, c.island_id, p.name AS province FROM cities c JOIN provinces p ON p.psgc = c.province_psgc WHERE c.key = $1`,
        [dto.cityKey],
      );
      if (!c) throw new NotFoundException('Place not found');
      origin = {
        lat: c.lat,
        lon: c.lon,
        cityKey: c.key,
        cityName: c.name,
        province: c.province,
        islandId: c.island_id,
      };
    } else {
      if (dto.lat === undefined || dto.lon === undefined)
        throw new BadRequestException('Give lat and lon, or a cityKey');
      const [c] = await this.db.query(
        `SELECT c.key, c.name, c.island_id, p.name AS province FROM cities c JOIN provinces p ON p.psgc = c.province_psgc
          WHERE ST_DWithin(c.geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 3000)
          ORDER BY c.geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326) LIMIT 1`,
        [dto.lon, dto.lat],
      );
      if (!c) throw new BadRequestException('That location is outside the Philippines or at sea');
      origin = {
        lat: dto.lat,
        lon: dto.lon,
        cityKey: c.key,
        cityName: c.name,
        province: c.province,
        islandId: c.island_id,
      };
    }

    const { limitMinutes } = this.sim.limits;
    const searchKm = this.sim.searchKm(limitMinutes);
    const candidates: Array<Record<string, unknown> & { km: number; island_id: number | null }> =
      await this.db.query(
        `SELECT c.id, c.name, c.address, c.phone, c.lat, c.lon, c.island_id, ci.name AS city, p.name AS province,
              ST_Distance(c.location::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) / 1000 AS km,
              COALESCE((SELECT array_agg(${LABEL('cq.qualification')} ORDER BY cq.qualification) FROM center_qualifications cq
                         WHERE cq.center_id = c.id), '{}') AS qualifications
         FROM assessment_centers c
         LEFT JOIN cities ci ON ci.id = c.city_id
         LEFT JOIN provinces p ON p.psgc = c.province_psgc
        WHERE c.include_in_analysis
          AND ($3::int IS NULL OR EXISTS (SELECT 1 FROM center_qualifications cq WHERE cq.center_id = c.id AND cq.qualification_id = $3))
          AND ($7::text IS NULL OR EXISTS (SELECT 1 FROM center_qualifications cq WHERE cq.center_id = c.id
                                             AND (lower(cq.qualification) = lower($7) OR lower(${LABEL('cq.qualification')}) = lower($7))))
          AND ($4::text IS NULL OR c.region_psgc = $4)
          AND ($5::text IS NULL OR c.province_psgc = $5)
          AND ST_DWithin(c.location::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $6 * 1000)
        ORDER BY c.location::geography <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
        LIMIT 60`,
        [
          origin.lon,
          origin.lat,
          dto.qualificationId ?? null,
          dto.regionPsgc ?? null,
          dto.provincePsgc ?? null,
          SEARCH_RADIUS_KM,
          dto.qualification || null,
        ],
      );

    // Qualification lists come from the TESDA API; a center whose detail call has never succeeded has none.
    let programData: { centersNearby: number; centersWithProgramData: number } | null = null;
    if (dto.qualificationId || dto.qualification) {
      const [cov] = await this.db.query(
        `SELECT count(*)::int AS nearby,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM center_qualifications cq WHERE cq.center_id = c.id))::int AS with_programs
           FROM assessment_centers c
          WHERE c.include_in_analysis
            AND ST_DWithin(c.location::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3 * 1000)`,
        [origin.lon, origin.lat, searchKm],
      );
      programData = { centersNearby: cov.nearby, centersWithProgramData: cov.with_programs };
    }
    // Live road + ferry times from the learner's exact point to every candidate (one OSRM call). null = use the estimate.
    const live = await this.routing.table(
      [{ lon: origin.lon, lat: origin.lat }],
      candidates.map((c) => ({ lon: c.lon as number, lat: c.lat as number })),
    );
    const from = { key: dto.cityKey ? origin.cityKey : null, lat: origin.lat, lon: origin.lon, islandId: origin.islandId };
    // Centers within 500 m (straight line) are walks. Their time comes from the foot network when it is up, so the list
    // matches the walking directions; a walk that turns out long (a river in between) is treated as a drive.
    const nearIdx = candidates.map((c, i) => (c.km * 1000 <= WALK_MAX_M ? i : -1)).filter((i) => i >= 0);
    const foot = await this.routing.table(
      [{ lon: origin.lon, lat: origin.lat }],
      nearIdx.map((i) => ({ lon: candidates[i]!.lon as number, lat: candidates[i]!.lat as number })),
      'walking',
    );
    const walkInfo = new Map<number, { minutes: number }>();
    nearIdx.forEach((ci, k) => {
      const c = candidates[ci]!;
      const m = foot?.minutes[0]?.[k];
      const km = foot?.km[0]?.[k];
      if (m === null || m === undefined || km === null || km === undefined) {
        if (!foot) walkInfo.set(ci, { minutes: walkMinutes(c.km * 1000) }); // no foot network: the straight-line estimate
      } else if (km <= WALK_MAX_ROUTE_KM) {
        walkInfo.set(ci, { minutes: Math.max(1, Math.ceil(m)) });
      }
    });
    const results = candidates
      .map((c, i) => {
        const w = walkInfo.get(i);
        const walk = w !== undefined;
        const minutes = walk
          ? w.minutes
          : (live?.minutes[0]?.[i] ??
            this.travel.minutes(from, { id: c.id as number, lat: c.lat as number, lon: c.lon as number, islandId: c.island_id }, c.km));
        return {
          mode: walk ? ('walking' as const) : ('driving' as const),
          id: c.id,
          name: c.name,
          address: c.address,
          phone: c.phone,
          city: c.city,
          province: c.province,
          lat: c.lat,
          lon: c.lon,
          km: Math.round(c.km * 10) / 10,
          minutes: Math.round(minutes),
          withinLimit: minutes <= limitMinutes,
          qualifications: c.qualifications as string[],
          directionsUrl: `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lon}&destination=${c.lat},${c.lon}&travelmode=driving`,
        };
      })
      .sort((a, b) => a.minutes - b.minutes)
      .slice(0, dto.limit);
    return {
      origin,
      filters: {
        qualificationId: dto.qualificationId ?? null,
        qualification: dto.qualification || null,
        regionPsgc: dto.regionPsgc ?? null,
        provincePsgc: dto.provincePsgc ?? null,
      },
      limitMinutes,
      travelModel: live ? this.routing.label : this.travel.name,
      /** true when no matching center is within the travel limit: the learner is in an assessment desert */
      desert: !results.some((r) => r.withinLimit),
      /**
       * With a qualification filter: how many centers nearby (within reach of the limit) have qualification data.
       * When few do, "no center offers it" may mean "no data yet" - the UI should say so.
       */
      programData,
      results,
    };
  }

  /**
   * Turn-by-turn road + ferry directions to one assessment center, from OSRM. Only routes to a center
   * (never to an arbitrary point), so this can't be used as a general routing proxy.
   */
  async route(dto: RouteDto): Promise<RouteResultDto> {
    const [center] = await this.db.query(
      `SELECT id, name, address, phone, lat, lon, coord_status FROM assessment_centers WHERE id = $1 AND include_in_analysis`,
      [dto.centerId],
    );
    if (!center) throw new NotFoundException('Assessment center not found');
    const [onLand] = await this.db.query(
      `SELECT 1 FROM cities c WHERE ST_DWithin(c.geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 3000) LIMIT 1`,
      [dto.lon, dto.lat],
    );
    if (!onLand) throw new BadRequestException('That location is outside the Philippines or at sea');
    const centerPoint = { id: center.id, name: center.name, address: center.address, phone: center.phone, lat: center.lat, lon: center.lon };

    // Close by: walk. Routed on footpaths and roads (OSRM foot profile) when that server is up; otherwise a straight-line
    // guide. A "walk" that turns out long (a river or highway in between) falls through to the driving route.
    const straightM = haversineKm(dto.lat, dto.lon, center.lat, center.lon) * 1000;
    if (straightM <= WALK_MAX_M) {
      const foot = await this.routing.route({ lon: dto.lon, lat: dto.lat }, { lon: center.lon, lat: center.lat }, 'walking');
      if (foot && foot !== 'none' && foot.distanceKm <= WALK_MAX_ROUTE_KM) {
        return {
          mode: 'walking',
          from: { lat: dto.lat, lon: dto.lon },
          center: centerPoint,
          km: Math.round(foot.distanceKm * 100) / 100,
          minutes: Math.max(1, Math.ceil(foot.minutes)),
          hasFerry: false,
          geometry: { type: 'LineString', coordinates: foot.coordinates },
          snapped: foot.snapped,
          locationVerified: center.coord_status === 'validated',
          steps: toRouteSteps(foot.steps, 'walking'),
          travelModel: 'osrm(foot, live)',
        };
      }
      if (foot === null) {
        // No foot network available: a straight-line guide, as the list does.
        const walk = walkSteps({ lat: dto.lat, lon: dto.lon }, center, straightM);
        return {
          mode: 'walking',
          from: { lat: dto.lat, lon: dto.lon },
          center: centerPoint,
          km: Math.round((straightM / 1000) * 100) / 100,
          minutes: walk.minutes,
          hasFerry: false,
          geometry: { type: 'LineString', coordinates: [[dto.lon, dto.lat], [center.lon, center.lat]] },
          snapped: { start: { lon: dto.lon, lat: dto.lat, distanceM: 0 }, end: { lon: center.lon, lat: center.lat, distanceM: 0 } },
          locationVerified: center.coord_status === 'validated',
          steps: walk.steps,
          travelModel: 'walking(straight line x 1.3 at about 4.8 km/h)',
        };
      }
    }

    if (!this.routing.enabled) {
      throw new ServiceUnavailableException('Turn-by-turn directions need the routing service, which is not enabled on this server');
    }
    const r = await this.routing.route({ lon: dto.lon, lat: dto.lat }, { lon: center.lon, lat: center.lat });
    if (r === 'none') throw new NotFoundException('No road or ferry route was found to this center');
    if (r === null) throw new ServiceUnavailableException('Directions are unavailable right now. Try again in a moment.');
    const steps = toRouteSteps(r.steps);
    return {
      mode: 'driving',
      from: { lat: dto.lat, lon: dto.lon },
      center: centerPoint,
      km: Math.round(r.distanceKm * 10) / 10,
      minutes: Math.round(r.minutes),
      hasFerry: steps.some((s) => s.mode === 'ferry'),
      geometry: { type: 'LineString', coordinates: r.coordinates },
      snapped: r.snapped,
      locationVerified: center.coord_status === 'validated',
      steps,
      travelModel: this.routing.label,
    };
  }
}
