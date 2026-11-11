import { BadRequestException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { routedIsochrones } from '../centers/isochrone';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import {
  AreaLevel,
  AreaUtilization,
  CenterUtilization,
  RunStatus,
  Role,
  RunSummary,
  SimulationRun,
} from '../database/entities';
import { AreaScopeService } from '../scope/area-scope.service';
import { DemandGroup, DemandService, QualificationCatalog } from './demand.service';
import { DemandRow, estimateQualificationNeed, qualificationKey } from './qualification-need';
import { EngineResult, SimCenter, SimGroup, UtilizationEngine } from './engine/utilization-engine';
import { CapacityEngine, CapacityResult } from './engine/capacity-engine';
import { Quarter, parseQuarter } from '../common/quarter';
import {
  AreaDeltaDto,
  PinReachQueryDto,
  RecommendationsDto,
  RecommendQueryDto,
  SiteRecommendationDto,
  SnapQueryDto,
  SnapResultDto,
  WhatIfDto,
  WhatIfResultDto,
} from './simulation.dto';
import { haversineKm } from '../common/geo/haversine';
import { desertLevel, isoBand } from '../common/rate-band';
import { MatrixTravelTimeModel, pairKey } from './travel/matrix-travel-time.model';
import { RoutingService } from './travel/routing.service';
import { TravelMatrixService } from './travel/travel-matrix.service';
import { TRAVEL_TIME_MODEL, TravelTimeModel } from './travel/travel-time.model';
import { nowEpoch } from '../database/epoch';

interface CenterMeta extends SimCenter {
  cityKey: string | null;
  provincePsgc: string | null;
  regionPsgc: string | null;
}

interface Inputs {
  centers: CenterMeta[];
  current: DemandGroup[];
  loadedAt: number;
  /** current-period result without any proposed center (reused by what-if), by travel limit in minutes */
  baselines: Map<number, EngineResult>;
  /** city names for what-if responses */
  names?: Map<string, string>;
  /** upcoming graduates per qualification, loaded the first time a qualification is asked for */
  catalog?: QualificationCatalog;
  /** which range (or 'all') the cached catalog covers */
  catalogKey?: string;
  offers?: Array<{ centerId: number; qualificationId: number | null; qualification: string }>;
  byQualification?: Map<string, Inputs>;
  /** set on the inputs of one qualification */
  qualification?: { key: string; name: string };
  /** capacity run: slots per center for this qualification and quarter */
  slots?: ReadonlyMap<number, number>;
  /** capacity run: the selected quarter */
  quarter?: Quarter;
}

interface AreaAgg {
  level: AreaLevel;
  key: string;
  parent: string | null;
  candidates: number;
  flagged: number;
  centers: number;
  /** capacity run only: slots and assigned candidates in this area */
  slots: number;
  assigned: number;
  /** cities: desert level 1-4 (0 = no); larger areas: the highest level inside */
  desertLevel: number;
  desertCities: number;
  desertCandidates: number;
  /** candidates that are an even share of a larger total, not a count */
  estimatedCandidates: number;
  /** cities only */
  nearestMinutes: number | null;
}

/**
 * Rolling basis (per day, per quarter): the latest run of each day for the last 90 days, the latest run of each
 * quarter forever, and the 5 most recent runs of any kind (so a few manual re-runs don't push the history out).
 * Days and quarters are Asia/Manila calendar days and quarters.
 */
const KEEP_DAILY_DAYS = 90;
const KEEP_LATEST_RUNS = 5;
const INPUT_TTL_MS = 10 * 60 * 1000;
/** A run made for a custom travel limit is reused for this long, then deleted. */
const ADHOC_TTL_SECONDS = 30 * 60;
/** A recommended site is moved to the nearest road only if that road is within this distance of the city point. */
const MAX_ROAD_SNAP_M = 3000;
/** A pin dropped by hand is moved onto the nearest road if one is within this distance. */
const MAX_MANUAL_SNAP_M = 5000;
/** At most this many desert cities (the biggest) are tried as sites for a new center. */
const MAX_SITE_CANDIDATES = 60;

@Injectable()
export class SimulationService {
  private readonly logger = new Logger(SimulationService.name);
  private inputs: Inputs | null = null;
  private running: Promise<unknown> | null = null;
  /** one-off runs in progress, by limit, so concurrent requests for the same limit share one run */
  private readonly adhocRunning = new Map<string, Promise<SimulationRun>>();

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly demand: DemandService,
    private readonly scope: AreaScopeService,
    private readonly config: ConfigService,
    @Inject(TRAVEL_TIME_MODEL) private readonly travel: TravelTimeModel,
    private readonly routing: RoutingService,
    private readonly matrix: TravelMatrixService,
  ) {}

  get limits() {
    return {
      limitMinutes: this.config.get<number>('SIM_LIMIT_MINUTES', 90),
      /** fastest average straight-line speed on any road, km/h: bounds the search only, never decides reach */
      maxSpeedKmh: this.config.get<number>('SIM_MAX_SPEED_KMH', 90),
    };
  }

  /**
   * How far (straight line) to look for centers within `limitMinutes`: the farthest anything could be in that time at
   * the fastest road pace. Only a search bound. Whether a center is in reach is decided by road travel time alone.
   */
  searchKm(limitMinutes = this.limits.limitMinutes): number {
    return Math.ceil((limitMinutes / 60) * this.limits.maxSpeedKmh);
  }

  engine(centers: SimCenter[], travel: TravelTimeModel = this.travel, limitMinutes = this.limits.limitMinutes) {
    return new UtilizationEngine(centers, { limitMinutes, searchKm: this.searchKm(limitMinutes), travel });
  }

  /**
   * Road + ferry minutes from each city near a dropped pin to the pin, routed live by OSRM. The pin isn't in the
   * precomputed matrix. Returns null when routing is off or unavailable (the pin then uses the estimate).
   */
  private async pinOverlay(pin: CenterMeta, groups: SimGroup[], limitMinutes: number): Promise<TravelTimeModel | null> {
    if (!this.routing.enabled || !(this.travel instanceof MatrixTravelTimeModel)) return null;
    const searchKm = this.searchKm(limitMinutes);
    const near = groups.filter((g) => haversineKm(g.lat, g.lon, pin.lat, pin.lon) <= searchKm);
    const t = await this.routing.table(
      near.map((g) => ({ lon: g.lon, lat: g.lat })),
      [{ lon: pin.lon, lat: pin.lat }],
    );
    if (!t) return null;
    const overlay = new Map<string, number>();
    near.forEach((g, i) => {
      const m = t.minutes[i]?.[0];
      if (m !== null && m !== undefined) overlay.set(pairKey(g.key, pin.id), m);
    });
    return this.travel.withOverlay(overlay);
  }

  private async loadInputs(force = false): Promise<Inputs> {
    if (!force && this.inputs && Date.now() - this.inputs.loadedAt < INPUT_TTL_MS) return this.inputs;
    if (force) await this.matrix.reload(); // pick up a freshly built travel matrix
    const rows: Array<{
      id: number;
      lat: number;
      lon: number;
      island_id: number | null;
      city_key: string | null;
      province_psgc: string | null;
      region_psgc: string | null;
    }> = await this.db.query(
      `SELECT c.id, c.lat, c.lon, c.island_id, ci.key AS city_key, c.province_psgc, c.region_psgc
           FROM assessment_centers c LEFT JOIN cities ci ON ci.id = c.city_id
          WHERE c.include_in_analysis ORDER BY c.id`,
    );
    const centers = rows.map((r) => ({
      id: r.id,
      lat: r.lat,
      lon: r.lon,
      islandId: r.island_id,
      cityKey: r.city_key,
      provincePsgc: r.province_psgc,
      regionPsgc: r.region_psgc,
    }));
    this.inputs = { centers, current: await this.demand.currentGroups(), loadedAt: Date.now(), baselines: new Map() };
    return this.inputs;
  }

  /** Run the check and store it. Serialized: one run at a time. */
  async runAll(triggeredBy: string): Promise<SimulationRun[]> {
    while (this.running) await this.running.catch(() => undefined);
    const job = this.doRun(triggeredBy);
    this.running = job;
    try {
      return await job;
    } finally {
      this.running = null;
    }
  }

  private async doRun(triggeredBy: string): Promise<SimulationRun[]> {
    const inputs = await this.loadInputs(true);
    const current = this.engine(inputs.centers).run(inputs.current);
    inputs.baselines.set(this.limits.limitMinutes, current);
    return [await this.persist(inputs, inputs.current, current, triggeredBy)];
  }

  private aggregate(inputs: Inputs, groups: DemandGroup[], r: EngineResult, capacity?: CapacityResult): AreaAgg[] {
    const map = new Map<string, AreaAgg>();
    const get = (level: AreaLevel, key: string, parent: string | null) => {
      const id = `${level}:${key}`;
      let a = map.get(id);
      if (!a)
        map.set(
          id,
          (a = {
            level,
            key,
            parent,
            candidates: 0,
            flagged: 0,
            centers: 0,
            slots: 0,
            assigned: 0,
            desertLevel: 0,
            desertCities: 0,
            desertCandidates: 0,
            estimatedCandidates: 0,
            nearestMinutes: null,
          }),
        );
      return a;
    };
    const cityParent = new Map<string, { p: string; r: string }>();
    for (const g of groups) {
      cityParent.set(g.key, { p: g.provincePsgc, r: g.regionPsgc });
      const reach = r.groups.get(g.key)!;
      const cap = capacity?.groups.get(g.key);
      const flagged = cap ? cap.flagged : reach.flagged;
      const nearestMinutes = cap ? cap.nearestMinutes : reach.nearestMinutes;
      const isDesert = g.count > 0 && nearestMinutes === null;
      const level = isDesert ? desertLevel(g.count) : 0;
      for (const a of [
        get(AreaLevel.NATIONAL, 'PH', null),
        get(AreaLevel.REGION, g.regionPsgc, 'PH'),
        get(AreaLevel.PROVINCE, g.provincePsgc, g.regionPsgc),
        get(AreaLevel.CITY, g.key, g.provincePsgc),
      ]) {
        a.candidates += g.count;
        a.flagged += flagged;
        a.assigned += cap?.assigned ?? 0;
        // Only a city's share is an estimate; the province total it was split from is a measured BSRS figure.
        if (a.level === AreaLevel.CITY && (g.source === 'split_province' || g.source === 'split_district')) a.estimatedCandidates += g.count;
        // Team doc: an assessment desert is a city with candidates and no center within the travel range.
        if (isDesert) {
          a.desertCities += 1;
          a.desertCandidates += g.count;
          a.desertLevel = Math.max(a.desertLevel, level);
        }
      }
      const city = map.get(`${AreaLevel.CITY}:${g.key}`)!;
      city.nearestMinutes = nearestMinutes === null ? null : Math.round(nearestMinutes * 10) / 10;
    }
    for (const c of inputs.centers) {
      const areas = [get(AreaLevel.NATIONAL, 'PH', null)];
      if (c.regionPsgc) areas.push(get(AreaLevel.REGION, c.regionPsgc, 'PH'));
      if (c.provincePsgc) areas.push(get(AreaLevel.PROVINCE, c.provincePsgc, c.regionPsgc));
      if (c.cityKey) areas.push(get(AreaLevel.CITY, c.cityKey, c.provincePsgc));
      const slots = inputs.slots?.get(c.id) ?? 0;
      for (const a of areas) {
        a.centers += 1;
        a.slots += slots;
      }
    }
    return [...map.values()];
  }

  private async persist(
    inputs: Inputs,
    groups: DemandGroup[],
    r: EngineResult,
    triggeredBy: string,
    custom?: { limitMinutes: number; qualification?: { key: string; name: string }; quarter?: Quarter },
    capacity?: CapacityResult,
  ) {
    const limitMinutes = custom?.limitMinutes ?? this.limits.limitMinutes;
    const runRepo = this.db.getRepository(SimulationRun);
    let run = await runRepo.save(
      runRepo.create({
        status: RunStatus.RUNNING,
        limitMinutes,
        travelModel: this.travel.name,
        triggeredBy,
        adhoc: !!custom,
        qualificationKey: custom?.qualification?.key ?? null,
        quarterStart: custom?.quarter?.start ?? null,
      }),
    );
    try {
      const areas = this.aggregate(inputs, groups, r, capacity);
      const totals = capacity ? capacity.totals : r.totals;
      const summary: RunSummary = {
        candidates: totals.candidates,
        flagged: totals.flagged,
        centers: inputs.centers.length,
        flaggedShare: totals.candidates ? totals.flagged / totals.candidates : 0,
        assumptions: {
          candidates: custom?.qualification
            ? `upcoming TESDA graduates in ${custom.qualification.name}, per town (province-only figures split over the towns)`
            : 'BSRS completed per city (province totals split by upcoming graduates where no city data)',
          centers: 'assessment centers listed by the TESDA Assessor Coverage API (synced nightly)',
          limitMinutes,
          travel: this.travel.name,
          ...(custom?.quarter ? { quarter: custom.quarter.label } : {}),
          ...(capacity ? { utilization: 'capacity-aware: nearest center with an open slot, 90 minutes' } : {}),
        },
      };
      await this.db.transaction(async (m) => {
        const areaRows = areas.map((a) =>
          m.create(AreaUtilization, {
            runId: run.id,
            level: a.level,
            areaKey: a.key,
            parentKey: a.parent,
            candidates: a.candidates,
            flagged: a.flagged,
            centers: a.centers,
            flaggedShare: a.candidates ? a.flagged / a.candidates : 0,
            slots: capacity ? a.slots : null,
            assigned: capacity ? a.assigned : null,
            utilization: capacity && a.slots > 0 ? a.candidates / a.slots : null,
            serviceRate: capacity && a.candidates > 0 ? a.assigned / a.candidates : null,
            desertLevel: a.desertLevel,
            desertCities: a.desertCities,
            desertCandidates: a.desertCandidates,
            estimatedCandidates: a.estimatedCandidates,
            nearestMinutes: a.nearestMinutes,
          }),
        );
        for (let i = 0; i < areaRows.length; i += 1000)
          await m.insert(AreaUtilization, areaRows.slice(i, i + 1000));
        const centerRows = capacity
          ? [...capacity.centers.values()].map((c) =>
              m.create(CenterUtilization, {
                runId: run.id,
                centerId: c.id,
                demand: c.demand,
                slots: c.slots,
                assigned: c.assigned,
                utilization: c.slots > 0 ? c.demand / c.slots : null,
                serviceRate: c.demand > 0 ? c.assigned / c.demand : null,
              }),
            )
          : [...r.centers.values()].map((c) =>
              m.create(CenterUtilization, {
                runId: run.id,
                centerId: c.id,
                demand: c.demand,
                slots: null,
                assigned: null,
                utilization: null,
                serviceRate: null,
              }),
            );
        for (let i = 0; i < centerRows.length; i += 1000)
          await m.insert(CenterUtilization, centerRows.slice(i, i + 1000));
        await m.update(SimulationRun, run.id, {
          status: RunStatus.COMPLETED,
          summary,
          finishedAt: nowEpoch(),
        });
      });
      if (!custom) await this.prune();
      run = await runRepo.findOneByOrFail({ id: run.id });
      this.logger.log(
        `run${custom ? ` @${limitMinutes}min` : ''} ${run.id}: ${summary.candidates} candidates, ${summary.flagged} flagged`,
      );
      return run;
    } catch (e) {
      await runRepo.update(run.id, {
        status: RunStatus.FAILED,
        error: (e as Error).message,
        finishedAt: nowEpoch(),
      });
      throw e;
    }
  }

  private async prune() {
    const since = nowEpoch() - KEEP_DAILY_DAYS * 86400;
    const bucket = (unit: string) => `date_trunc('${unit}', to_timestamp(started_at) AT TIME ZONE 'Asia/Manila')`;
    await this.db.query(
      `DELETE FROM simulation_runs WHERE NOT adhoc AND id NOT IN (
         (SELECT DISTINCT ON (${bucket('day')}) id FROM simulation_runs
           WHERE NOT adhoc AND status = 'COMPLETED' AND started_at >= $1
           ORDER BY ${bucket('day')}, started_at DESC)
         UNION
         (SELECT DISTINCT ON (${bucket('quarter')}) id FROM simulation_runs
           WHERE NOT adhoc AND status = 'COMPLETED'
           ORDER BY ${bucket('quarter')}, started_at DESC)
         UNION
         (SELECT id FROM simulation_runs WHERE NOT adhoc ORDER BY started_at DESC LIMIT $2)
       )`,
      [since, KEEP_LATEST_RUNS],
    );
  }

  async latestRun(): Promise<SimulationRun> {
    const run = await this.db.getRepository(SimulationRun).findOne({
      where: { status: RunStatus.COMPLETED, adhoc: false },
      order: { finishedAt: 'DESC' },
    });
    if (!run) throw new NotFoundException('No completed simulation yet - run POST /simulation/runs');
    return run;
  }

  /**
   * The run a dashboard request should read: the stored one, or - when the caller asks for a different travel limit
   * (?limitMinutes=) - a one-off run with that limit. One-off runs are stored like any run (so the dashboard queries
   * read them unchanged) but flagged `adhoc`, kept for ADHOC_TTL_SECONDS and never part of the history.
   */
  async runFor(limitMinutes?: number, qualification?: string, quarterLabel?: string): Promise<SimulationRun> {
    const qualKey = qualification ? qualificationKey(qualification) : '';
    const quarter = quarterLabel ? parseQuarter(quarterLabel) ?? undefined : undefined;
    if (quarterLabel && !quarter) throw new BadRequestException('quarter must look like 2026-Q4');
    if (quarter && !qualKey) throw new BadRequestException('qualification is required with quarter');
    const limit = limitMinutes ?? this.limits.limitMinutes;
    if (!qualKey && !quarter && limit === this.limits.limitMinutes) return this.latestRun();
    await this.latestRun(); // same 404 as the default path when nothing has been simulated yet
    const key = `${limit}|${qualKey}|${quarter?.label ?? ''}`;
    const busy = this.adhocRunning.get(key);
    if (busy) return busy;
    const job = this.adhocRun(limit, qualKey, quarter).finally(() => this.adhocRunning.delete(key));
    this.adhocRunning.set(key, job);
    return job;
  }

  private async adhocRun(limitMinutes: number, qualKey: string, quarter?: Quarter): Promise<SimulationRun> {
    const cutoff = nowEpoch() - ADHOC_TTL_SECONDS;
    await this.db.query(`DELETE FROM simulation_runs WHERE adhoc AND started_at < $1`, [cutoff]);
    const fresh = await this.db.getRepository(SimulationRun).findOne({
      where: {
        status: RunStatus.COMPLETED,
        adhoc: true,
        limitMinutes,
        qualificationKey: qualKey || IsNull(),
        quarterStart: quarter ? quarter.start : IsNull(),
      },
      order: { finishedAt: 'DESC' },
    });
    if (fresh) return fresh;
    const inputs = qualKey ? await this.qualificationInputs(qualKey, quarter) : await this.loadInputs();
    const reach = this.engine(inputs.centers, this.travel, limitMinutes).run(inputs.current);
    let capacity: CapacityResult | undefined;
    if (quarter) {
      const centers = inputs.centers.map((c) => ({ ...c, slots: inputs.slots?.get(c.id) ?? 0 }));
      capacity = new CapacityEngine(centers, {
        limitMinutes,
        searchKm: this.searchKm(limitMinutes),
        travel: this.travel,
      }).run(inputs.current);
    }
    return this.persist(
      inputs,
      inputs.current,
      reach,
      'adhoc',
      { limitMinutes, qualification: inputs.qualification, quarter },
      capacity,
    );
  }

  private async qualificationCatalog(inputs: Inputs, quarter?: Quarter) {
    const catalogKey = quarter?.label ?? 'all';
    if (inputs.catalogKey !== catalogKey || !inputs.catalog) {
      inputs.catalog = await this.demand.qualificationCatalog(quarter && { start: quarter.start, end: quarter.end });
      inputs.catalogKey = catalogKey;
    }
    inputs.offers ??= await this.db.query(
      `SELECT center_id AS "centerId", qualification_id AS "qualificationId", qualification
         FROM center_qualifications WHERE accredited_until IS NULL OR accredited_until >= $1`,
      [nowEpoch()],
    );
    return { catalog: inputs.catalog, offers: inputs.offers };
  }

  /** The simulation inputs for one qualification: its candidates, and only the centers accredited for it. */
  private async qualificationInputs(raw: string, quarter?: Quarter): Promise<Inputs> {
    const inputs = await this.loadInputs();
    const key = qualificationKey(raw);
    const cacheKey = `${key}|${quarter?.label ?? ''}`;
    const cached = inputs.byQualification?.get(cacheKey);
    if (cached) return cached;
    const { catalog, offers } = await this.qualificationCatalog(inputs, quarter);
    const q = catalog.byKey.get(key);
    if (!q) throw new BadRequestException('Unknown qualification');
    const ids = new Set(offers.filter((o) => qualificationKey(o.qualification) === key || (o.qualificationId !== null && q.ids.has(o.qualificationId))).map((o) => o.centerId));
    const slots = quarter
      ? new Map<number, number>(
          (
            await this.db.query(
              `SELECT center_id, sum(slots)::int AS slots
                 FROM center_qualification_slots
                WHERE month_start >= $1 AND month_start < $2 AND qualification_key = $3
                GROUP BY center_id`,
              [quarter.start, quarter.end, key],
            )
          ).map((r: { center_id: number; slots: number }) => [r.center_id, r.slots]),
        )
      : undefined;
    const derived: Inputs = {
      ...inputs,
      centers: inputs.centers.filter((c) => ids.has(c.id)),
      current: this.demand.qualificationGroups(catalog.cities, q),
      baselines: new Map(),
      qualification: { key, name: q.name },
      slots,
      quarter,
    };
    (inputs.byQualification ??= new Map()).set(cacheKey, derived);
    return derived;
  }

  /** The qualifications with upcoming graduates, and how many listed centers are accredited for each. */
  async qualifications(): Promise<Array<{ key: string; name: string; centers: number }>> {
    const inputs = await this.loadInputs();
    const { catalog, offers } = await this.qualificationCatalog(inputs);
    const listed = new Set(inputs.centers.map((c) => c.id));
    return [...catalog.byKey.values()]
      .map((q) => ({
        key: q.key,
        name: q.name,
        centers: new Set(offers.filter((o) => listed.has(o.centerId) && (qualificationKey(o.qualification) === q.key || (o.qualificationId !== null && q.ids.has(o.qualificationId)))).map((o) => o.centerId)).size,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Move a pin dropped or dragged by hand onto the nearest drivable road (OpenStreetMap, from the routing server), so a
   * proposed center is never in a forest or on the water. The pin stays where it was dropped when no road is within
   * 5 km, when routing is down, or when the road point would fall outside the office's area or the chosen area.
   */
  async snapPin(user: AuthUser, q: SnapQueryDto): Promise<SnapResultDto> {
    if ((q.level === undefined) !== (q.code === undefined)) throw new BadRequestException('level and code go together');
    const planArea = q.level ? await this.scope.resolve(user, q.level, q.code) : null;
    const stay = { lat: q.lat, lon: q.lon, onRoad: false, roadName: null as string | null, movedMeters: 0 };
    const hit = await this.routing.snapToRoad({ lat: q.lat, lon: q.lon });
    if (!hit || hit.distanceM > MAX_MANUAL_SNAP_M) return stay;
    if (!(await this.scope.pointAllowed(user, hit.lat, hit.lon))) return stay;
    if (planArea && !(await this.scope.pointInArea(planArea, hit.lat, hit.lon))) return stay;
    return { lat: hit.lat, lon: hit.lon, onRoad: true, roadName: hit.road, movedMeters: hit.distanceM };
  }

  /** The current result without any proposed center, for one travel limit (cached with the inputs). */
  private baselineFor(inputs: Inputs, limitMinutes: number): EngineResult {
    let r = inputs.baselines.get(limitMinutes);
    if (!r) {
      r = this.engine(inputs.centers, this.travel, limitMinutes).run(inputs.current);
      inputs.baselines.set(limitMinutes, r);
    }
    return r;
  }

  /**
   * Where a new center would do the most good. Candidate sites are the biggest assessment-desert cities of the area
   * (a city with candidates and no center in reach). Each site is a point inside the city moved to the nearest
   * drivable road. A site's value is the candidates in every desert whose ROAD travel time to that point is within the
   * travel limit (the routing server's road and ferry minutes; the distance estimate only if routing is down). The
   * best site is picked, its deserts are set aside, and the next best is picked from what is left (greedy), so the
   * sites don't overlap. The what-if gives the exact result once a pin is dropped.
   */
  async recommend(user: AuthUser, q: RecommendQueryDto): Promise<RecommendationsDto> {
    const area = await this.scope.resolve(user, q.level, q.code);
    const quarter = q.quarter ? parseQuarter(q.quarter) ?? undefined : undefined;
    if (q.quarter && !quarter) throw new BadRequestException('quarter must look like 2026-Q4');
    const inputs = q.qualification ? await this.qualificationInputs(q.qualification, quarter) : await this.loadInputs();
    const limitMinutes = q.limitMinutes ?? this.limits.limitMinutes;
    const base = this.baselineFor(inputs, limitMinutes);
    const inArea = (g: DemandGroup) =>
      area.level === AreaLevel.NATIONAL ||
      (area.level === AreaLevel.REGION ? g.regionPsgc === area.code : g.provincePsgc === area.code);
    const deserts = inputs.current.filter((g) => g.count > 0 && inArea(g) && base.groups.get(g.key)!.nearestMinutes === null);

    inputs.names ??= new Map<string, string>(
      (await this.db.query(`SELECT key, name FROM cities`)).map((c: { key: string; name: string }) => [c.key, c.name]),
    );
    const names = inputs.names;

    // The biggest deserts are the candidate sites (a far-flung tiny one is never the best place for a center).
    const sitesPool = [...deserts].sort((a, b) => b.count - a.count).slice(0, MAX_SITE_CANDIDATES);
    // A point that is surely inside each city (the centroid of a crescent or an island group can fall in the sea),
    // then moved to the nearest drivable road, as long as that stays inside the area and the office's scope.
    const inside: Array<{ key: string; province: string | null; lat: number; lon: number }> = sitesPool.length
      ? await this.db.query(
          `SELECT c.key, p.name AS province, ST_Y(ST_PointOnSurface(c.geom)) AS lat, ST_X(ST_PointOnSurface(c.geom)) AS lon
             FROM cities c LEFT JOIN provinces p ON p.psgc = c.province_psgc WHERE c.key = ANY($1::text[])`,
          [sitesPool.map((p) => p.key)],
        )
      : [];
    const insideOf = new Map(inside.map((r) => [r.key, r]));
    const placed = await Promise.all(
      sitesPool.map(async (site) => {
        const b = insideOf.get(site.key);
        const start = { lat: b?.lat ?? site.lat, lon: b?.lon ?? site.lon };
        const hit = await this.routing.snapToRoad(start);
        const ok =
          !!hit &&
          hit.distanceM <= MAX_ROAD_SNAP_M &&
          (area.level === AreaLevel.NATIONAL || (await this.scope.pointInArea(area, hit.lat, hit.lon))) &&
          (await this.scope.pointAllowed(user, hit.lat, hit.lon));
        return ok && hit
          ? { lat: hit.lat, lon: hit.lon, onRoad: true, roadName: hit.road, movedMeters: hit.distanceM }
          : { ...start, onRoad: false, roadName: null as string | null, movedMeters: 0 };
      }),
    );

    // Road + ferry minutes from every desert city to every candidate site, in one routed table (chunked by the client).
    const live = await this.routing.table(
      deserts.map((g) => ({ lon: g.lon, lat: g.lat })),
      placed.map((p) => ({ lon: p.lon, lat: p.lat })),
    );
    const searchKm = this.searchKm(limitMinutes);
    const minutes = (i: number, j: number): number | null => {
      const m = live?.minutes[i]?.[j];
      if (m !== undefined) return m; // null = no road or ferry connection
      // routing is off or down: the distance estimate, looking no farther than the search bound
      const g = deserts[i]!;
      const p = placed[j]!;
      const km = haversineKm(g.lat, g.lon, p.lat, p.lon);
      if (km > searchKm) return null;
      return this.travel.minutes({ key: g.key, lat: g.lat, lon: g.lon, islandId: g.islandId }, { id: -1, lat: p.lat, lon: p.lon, islandId: sitesPool[j]!.islandId }, km);
    };
    const reach = sitesPool.map((site, j) =>
      deserts.map((g, i) => g.key === site.key || (minutes(i, j) ?? Infinity) <= limitMinutes),
    );

    const picks: Array<{ j: number; served: DemandGroup[] }> = [];
    const taken = new Set<string>(); // deserts already served by an earlier pick
    const usedSites = new Set<number>();
    while (picks.length < q.count) {
      let best: { j: number; served: DemandGroup[]; people: number } | null = null;
      sitesPool.forEach((site, j) => {
        if (usedSites.has(j) || taken.has(site.key)) return;
        const served = deserts.filter((g, i) => !taken.has(g.key) && reach[j]![i]);
        const people = served.reduce((n, c) => n + c.count, 0);
        if (!best || people > best.people || (people === best.people && served.length > best.served.length)) best = { j, served, people };
      });
      if (!best) break;
      const chosen: { j: number; served: DemandGroup[]; people: number } = best;
      picks.push({ j: chosen.j, served: chosen.served });
      usedSites.add(chosen.j);
      chosen.served.forEach((g) => taken.add(g.key));
    }
    // Qualifications to offer: the upcoming graduates' qualification mix of the provinces each site would serve.
    const provinces = [...new Set(picks.flatMap((p) => p.served.map((g) => g.provincePsgc)))];
    const demand: DemandRow[] = provinces.length
      ? await this.db.query(
          `SELECT province_psgc AS "provincePsgc", min(qualification_id) AS "qualificationId", min(qualification) AS qualification,
                  sum(graduates)::int AS graduates
             FROM upcoming_graduates WHERE province_psgc = ANY($1::text[])
            GROUP BY province_psgc, lower(qualification)`,
          [provinces],
        )
      : [];
    const offered: Array<{ province: string; centerId: number; qid: number | null; label: string }> = demand.length
      ? await this.db.query(
          `SELECT c.province_psgc AS province, c.id AS "centerId", cq.qualification_id AS qid, cq.qualification AS label
             FROM assessment_centers c JOIN center_qualifications cq ON cq.center_id = c.id
            WHERE c.include_in_analysis AND c.province_psgc = ANY($1::text[])`,
          [provinces],
        )
      : [];
    // province -> centers offering, by qualification id and by normalised name (about 20% of the TESDA list has no id)
    const supplyIndex = new Map<string, Set<number>>();
    for (const o of offered) {
      for (const k of [o.qid !== null ? `${o.province}|id:${o.qid}` : null, `${o.province}|k:${qualificationKey(o.label)}`]) {
        if (!k) continue;
        (supplyIndex.get(k) ?? supplyIndex.set(k, new Set()).get(k)!).add(o.centerId);
      }
    }
    const supply = (provs: Set<string>, qualificationId: number | null, qualification: string) => {
      const centers = new Set<number>();
      for (const prov of provs) {
        for (const k of [qualificationId !== null ? `${prov}|id:${qualificationId}` : null, `${prov}|k:${qualificationKey(qualification)}`])
          for (const c of (k && supplyIndex.get(k)) || []) centers.add(c);
      }
      return centers.size;
    };
    const sites: SiteRecommendationDto[] = picks.map((p, i) => {
      const site = sitesPool[p.j]!;
      return {
        rank: i + 1,
        cityKey: site.key,
        cityName: names.get(site.key) ?? site.key,
        provinceName: insideOf.get(site.key)?.province ?? null,
        ...placed[p.j]!,
        newlyServed: p.served.reduce((n, c) => n + c.count, 0),
        desertCitiesClosed: p.served.length,
        desertNames: [...p.served].sort((a, b) => b.count - a.count).slice(0, 6).map((c) => names.get(c.key) ?? c.key),
        topQualifications: estimateQualificationNeed(p.served.map((g) => ({ provincePsgc: g.provincePsgc, count: g.count })), demand, supply, 3),
      };
    });
    return {
      area: { level: area.level, code: area.code, name: area.name },
      limitMinutes,
      desertCities: deserts.length,
      desertCandidates: deserts.reduce((n, c) => n + c.count, 0),
      sites,
      qualificationSource: demand.length
        ? "Upcoming TESDA graduates (next 6 months) per province and qualification. The province's mix is applied to the candidates the site would serve, so the counts are estimates."
        : null,
    };
  }

  /** Drag and drop: add a proposed center, re-run the check in memory, compare. Nothing is stored. */
  /**
   * Check a proposed center's pin (the office may plan there, on land, inside the area asked for) and place it: the
   * city it lands in and that city's island. Shared by the what-if and the pin's reach map.
   */
  private async placePin(user: AuthUser, dto: { lat: number; lon: number; level?: AreaLevel; code?: string }) {
    if ((dto.level === undefined) !== (dto.code === undefined))
      throw new BadRequestException('level and code go together');
    // the area to plan in and report on: the one asked for (the office must be allowed to see it), else the home area
    const planArea = dto.level ? await this.scope.resolve(user, dto.level, dto.code) : await this.scope.home(user);
    if (!(await this.scope.pointAllowed(user, dto.lat, dto.lon))) {
      throw new BadRequestException('Drop the new center inside your office area (on land)');
    }
    if (dto.level && !(await this.scope.pointInArea(planArea, dto.lat, dto.lon))) {
      throw new BadRequestException(`Drop the new center inside ${planArea.name} (on land)`);
    }
    const [where] = await this.db.query(
      `SELECT c.key, c.name, c.island_id, c.province_psgc, c.region_psgc, p.name AS province_name, r.name AS region_name
         FROM cities c
         LEFT JOIN provinces p ON p.psgc = c.province_psgc
         LEFT JOIN regions r ON r.psgc = c.region_psgc
        ORDER BY c.geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326) LIMIT 1`,
      [dto.lon, dto.lat],
    );
    const pin: CenterMeta = {
      id: -1,
      lat: dto.lat,
      lon: dto.lon,
      islandId: where?.island_id ?? null,
      cityKey: where?.key ?? null,
      provincePsgc: where?.province_psgc ?? null,
      regionPsgc: where?.region_psgc ?? null,
    };
    return { planArea, where, pin };
  }

  /**
   * The cities a proposed center would reach within the travel limit, as GeoJSON for the planner's map (shaded like a
   * clicked center's reach). Uses the what-if's own travel times, so the shaded area matches the what-if result.
   */
  /**
   * True drive-time areas around a proposed center (a dropped pin), as the dashboard draws for an existing center: a
   * grid around the pin routed by road and ferry, banded into thirds of the travel limit. The pin goes through the same
   * scope check as its reach. Cached for 10 minutes per point and limit.
   */
  async pinIsochrone(user: AuthUser, dto: PinReachQueryDto) {
    const { pin } = await this.placePin(user, dto);
    if (!this.routing.enabled) throw new ServiceUnavailableException('Drive-time areas need the routing service, which is not enabled on this server');
    const limitMinutes = dto.limitMinutes ?? this.limits.limitMinutes;
    const key = `${pin.lat.toFixed(4)}|${pin.lon.toFixed(4)}|${limitMinutes}`;
    const hit = this.pinIsoCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
    const iso = await routedIsochrones({ lon: pin.lon, lat: pin.lat }, limitMinutes, this.searchKm(limitMinutes), (s, d) => this.routing.table(s, d));
    if (!iso) throw new ServiceUnavailableException('Drive-time areas are unavailable right now. Try again in a moment.');
    const value = {
      type: 'FeatureCollection' as const,
      properties: {
        center: { id: 0, name: 'New assessment center', lat: pin.lat, lon: pin.lon },
        minutes: iso.breaks,
        radiusKm: iso.radiusKm,
        spacingKm: iso.spacingKm,
        travelModel: this.routing.label,
        gridPoints: iso.built.points,
        reachedPoints: iso.built.reached,
        samples: iso.built.samples,
      },
      features: iso.features,
    };
    this.pinIsoCache.set(key, { at: Date.now(), value });
    if (this.pinIsoCache.size > 50) this.pinIsoCache.delete(this.pinIsoCache.keys().next().value!);
    return value;
  }

  private readonly pinIsoCache = new Map<string, { at: number; value: unknown }>();

  async pinReach(user: AuthUser, dto: PinReachQueryDto) {
    const { pin } = await this.placePin(user, dto);
    const limitMinutes = dto.limitMinutes ?? this.limits.limitMinutes;
    // every city near the pin, with or without candidates: the map shows where the center reaches, not only demand
    const rows: Array<{ key: string; name: string; island_id: number | null; lat: number; lon: number; km: number; geometry: string }> =
      await this.db.query(
        `SELECT key, name, island_id, lat, lon,
                ST_Distance(centroid::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) / 1000 AS km,
                ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, 0.0007), 5) AS geometry
           FROM cities
          WHERE ST_DWithin(centroid::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3 * 1000)`,
        [pin.lon, pin.lat, this.searchKm(limitMinutes)],
      );
    // cities -> the pin by road and ferry, one OSRM table call (the what-if times the pin the same way); else the estimate
    const live = await this.routing.table(
      rows.map((r) => ({ lon: r.lon, lat: r.lat })),
      [{ lon: pin.lon, lat: pin.lat }],
    );
    const dest = { id: pin.id, lat: pin.lat, lon: pin.lon, islandId: pin.islandId };
    const features = rows
      .map((r, i) => ({
        r,
        minutes: live?.minutes[i]?.[0] ?? this.travel.minutes({ key: r.key, lat: r.lat, lon: r.lon, islandId: r.island_id }, dest, r.km),
      }))
      .filter((x) => x.minutes <= limitMinutes)
      .map(({ r, minutes }) => ({
        type: 'Feature' as const,
        id: r.key,
        geometry: JSON.parse(r.geometry),
        properties: {
          key: r.key,
          name: r.name,
          km: Math.round(r.km * 10) / 10,
          minutes: Math.round(minutes),
          withinLimit: true,
          isoBand: isoBand(minutes, limitMinutes),
        },
      }));
    return {
      type: 'FeatureCollection' as const,
      properties: {
        center: { id: pin.id, name: 'New assessment center', lat: pin.lat, lon: pin.lon },
        limitMinutes,
        travelModel: live ? this.routing.label : this.travel.name,
        citiesWithinLimit: features.length,
      },
      features,
    };
  }

  async whatIf(user: AuthUser, dto: WhatIfDto): Promise<WhatIfResultDto> {
    const { planArea, where, pin } = await this.placePin(user, dto);
    const inputs = await this.loadInputs();
    const limitMinutes = dto.limitMinutes ?? this.limits.limitMinutes;
    const before = this.baselineFor(inputs, limitMinutes);
    const after = this.engine(
      [...inputs.centers, pin],
      (await this.pinOverlay(pin, inputs.current, limitMinutes)) ?? this.travel,
      limitMinutes,
    ).run(inputs.current);

    const delta = (level: AreaLevel, code: string, name: string): AreaDeltaDto => {
      const inArea = (g: DemandGroup) =>
        level === AreaLevel.NATIONAL ||
        (level === AreaLevel.REGION ? g.regionPsgc === code : g.provincePsgc === code);
      const sum = (r: EngineResult) => {
        let candidates = 0,
          flagged = 0,
          deserts = 0;
        for (const g of inputs.current) {
          if (inArea(g)) {
            candidates += g.count;
            flagged += r.groups.get(g.key)!.flagged;
            if (g.count > 0 && r.groups.get(g.key)!.nearestMinutes === null) deserts += 1; // no center within the travel range
          }
        }
        return { candidates, flagged, deserts };
      };
      const b = sum(before);
      const a = sum(after);
      return {
        level,
        code,
        name,
        candidates: b.candidates,
        flaggedBefore: b.flagged,
        flaggedAfter: a.flagged,
        flaggedShareBefore: b.candidates ? b.flagged / b.candidates : 0,
        flaggedShareAfter: a.candidates ? a.flagged / a.candidates : 0,
        desertCitiesBefore: b.deserts,
        desertCitiesAfter: a.deserts,
      };
    };

    inputs.names ??= new Map<string, string>(
      (await this.db.query(`SELECT key, name FROM cities`)).map((c: { key: string; name: string }) => [
        c.key,
        c.name,
      ]),
    );
    const names = inputs.names;
    const improved = inputs.current
      .map((g) => ({
        key: g.key,
        name: names.get(g.key) ?? g.key,
        flaggedBefore: before.groups.get(g.key)!.flagged,
        flaggedAfter: after.groups.get(g.key)!.flagged,
      }))
      .filter((c) => c.flaggedAfter < c.flaggedBefore)
      .sort((x, y) => y.flaggedBefore - y.flaggedAfter - (x.flaggedBefore - x.flaggedAfter));
    // Where the pin landed, as far as this office may see: CO region + province, RO province, PO nothing more.
    const placeAreas = (): AreaDeltaDto[] => {
      const out: AreaDeltaDto[] = [];
      if (user.role === Role.CO && where?.region_psgc)
        out.push(delta(AreaLevel.REGION, where.region_psgc, where.region_name ?? where.region_psgc));
      if ((user.role === Role.CO || user.role === Role.RO) && where?.province_psgc)
        out.push(delta(AreaLevel.PROVINCE, where.province_psgc, where.province_name ?? where.province_psgc));
      return out;
    };
    const pinRes = after.centers.get(-1)!;
    return {
      pin: {
        lat: dto.lat,
        lon: dto.lon,
        cityKey: where?.key ?? null,
        cityName: where?.name ?? null,
      },
      newlyServed: before.totals.flagged - after.totals.flagged,
      pinDemand: pinRes.demand,
      limitMinutes,
      area: delta(planArea.level, planArea.code, planArea.name),
      national: delta(AreaLevel.NATIONAL, 'PH', 'Philippines'),
      placeAreas: placeAreas(),
      improvedCities: improved.slice(0, 50),
    };
  }
}
