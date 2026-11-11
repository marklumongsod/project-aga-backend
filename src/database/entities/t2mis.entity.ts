import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, PrimaryGeneratedColumn, Unique } from 'typeorm';
import type { Point } from 'geojson';
import { City, Province } from './geography.entity';
import { EPOCH_NOW_SQL, epochTransformer } from '../epoch';

/** T2MIS qualification (QualId). */
@Entity({ name: 'qualifications' })
export class Qualification {
  @PrimaryColumn({ type: 'int' })
  id: number;

  @Column({ name: 'sector_id', type: 'int', nullable: true })
  sectorId: number | null;

  @Index()
  @Column()
  title: string;

  @Column({ type: 'varchar', nullable: true })
  code: string | null;

  @Column({ name: 'level_id', type: 'int', nullable: true })
  levelId: number | null;

  @Column({ default: true })
  enabled: boolean;
}

/** T2MIS assessment center (CenterId) with Team C's validated geocode. */
@Entity({ name: 'assessment_centers' })
export class AssessmentCenter {
  @PrimaryColumn({ type: 'int' })
  id: number;

  @Column()
  name: string;

  @Column({ type: 'varchar', nullable: true })
  address: string | null;

  @Column({ type: 'varchar', nullable: true })
  phone: string | null;

  @Column({ type: 'varchar', nullable: true })
  email: string | null;

  @Column({ type: 'varchar', nullable: true })
  district: string | null;

  @Column({ name: 'source_region_name', type: 'varchar', nullable: true })
  sourceRegionName: string | null;

  @Column({ name: 'source_province_name', type: 'varchar', nullable: true })
  sourceProvinceName: string | null;

  @Column({ name: 'source_city_name', type: 'varchar', nullable: true })
  sourceCityName: string | null;

  @Column({ type: 'double precision' })
  lat: number;

  @Column({ type: 'double precision' })
  lon: number;

  @Column({ type: 'geometry', spatialFeatureType: 'Point', srid: 4326, nullable: true, select: false })
  location?: Point;

  /** validated | geocoded_fill | geocode_override | water_fixed_geocode | unverified | disputed */
  @Column({ name: 'coord_status' })
  coordStatus: string;

  @Column({ name: 'coord_source' })
  coordSource: string;

  @Column({ name: 'is_foreign', default: false })
  isForeign: boolean;

  @Column({ name: 'is_closed', default: false })
  isClosed: boolean;

  @Column({ name: 'is_hidden', default: false })
  isHidden: boolean;

  /** false for foreign, closed, hidden/test or unverified coordinates */
  @Index()
  @Column({ name: 'include_in_analysis', default: true })
  includeInAnalysis: boolean;

  @Column({ name: 'city_id', type: 'int', nullable: true })
  cityId: number | null;

  @ManyToOne(() => City)
  @JoinColumn({ name: 'city_id' })
  city?: City;

  @Index()
  @Column({ name: 'province_psgc', type: 'char', length: 10, nullable: true })
  provincePsgc: string | null;

  @Index()
  @Column({ name: 'region_psgc', type: 'char', length: 10, nullable: true })
  regionPsgc: string | null;

  @Column({ name: 'island_id', type: 'int', nullable: true })
  islandId: number | null;

  @Column({ name: 'created_at', type: 'bigint', nullable: true, transformer: epochTransformer })
  createdAt: number | null;

  @Column({ type: 'varchar', nullable: true })
  website: string | null;

  /** latest expiry of the center's accreditations, from the TESDA API */
  @Column({ name: 'accredited_until', type: 'bigint', nullable: true, transformer: epochTransformer })
  accreditedUntil: number | null;

  /** null = never synced (seed data); true/false = in the latest TESDA API pull. Only listed centers are analysed. */
  @Column({ name: 'tesda_listed', type: 'boolean', nullable: true })
  tesdaListed: boolean | null;

  @Column({ name: 'synced_at', type: 'bigint', nullable: true, transformer: epochTransformer })
  syncedAt: number | null;
}

/** A qualification a center is accredited for, as the TESDA API names it ("Cookery II"). */
@Entity({ name: 'center_qualifications' })
export class CenterQualification {
  @PrimaryColumn({ name: 'center_id', type: 'int' })
  centerId: number;

  @PrimaryColumn()
  qualification: string;

  /** the T2MIS QualId whose title + level matches the name, if any */
  @Index()
  @Column({ name: 'qualification_id', type: 'int', nullable: true })
  qualificationId: number | null;

  @Column({ name: 'accredited_until', type: 'bigint', nullable: true, transformer: epochTransformer })
  accreditedUntil: number | null;

  @ManyToOne(() => AssessmentCenter, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'center_id' })
  center?: AssessmentCenter;

  @ManyToOne(() => Qualification, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'qualification_id' })
  qualificationRef?: Qualification;
}

/**
 * Upcoming graduates (next 6 months, from the TESDA API's students list) of one qualification, finishing in one month,
 * in one town, or in one province when the API doesn't know the town (`cityId` null). Counts only, never a student.
 */
@Entity({ name: 'upcoming_graduates' })
export class UpcomingGraduates {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('IDX_upcoming_graduates_province')
  @Column({ name: 'province_psgc', type: 'char', length: 10 })
  provincePsgc: string;

  @ManyToOne(() => Province, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'province_psgc' })
  province?: Province;

  @Index('IDX_upcoming_graduates_city')
  @Column({ name: 'city_id', type: 'int', nullable: true })
  cityId: number | null;

  @ManyToOne(() => City, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'city_id' })
  city?: City;

  /** as the TESDA API names it, e.g. "Cookery II" */
  @Column()
  qualification: string;

  /** the T2MIS QualId when the name matches one (about 80% do) */
  @Column({ name: 'qualification_id', type: 'int', nullable: true })
  qualificationId: number | null;

  @ManyToOne(() => Qualification, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'qualification_id' })
  qualificationRef?: Qualification;

  /** 00:00 Asia/Manila on the 1st of the finish month, epoch seconds */
  @Column({ name: 'finish_month', type: 'bigint', transformer: epochTransformer })
  finishMonth: number;

  @Column({ type: 'int' })
  graduates: number;

  /** 'tesda' for the nightly API sync, 'demo' for local demo data */
  @Index('IDX_upcoming_graduates_source')
  @Column({ default: 'tesda' })
  source: string;
}

/**
 * Assessment capacity of one center for one qualification in one month. Slots are counted per program, per center,
 * per month; a quarter's capacity is the sum of its three months. `source` is 'demo' until TESDA/NCR provide real data.
 */
@Entity({ name: 'center_qualification_slots' })
@Unique('UQ_center_qualification_slots', ['centerId', 'qualificationKey', 'monthStart'])
export class CenterQualificationSlot {
  @PrimaryGeneratedColumn()
  id: number;

  @Index('IDX_center_qualification_slots_center')
  @Column({ name: 'center_id', type: 'int' })
  centerId: number;

  @ManyToOne(() => AssessmentCenter, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'center_id' })
  center?: AssessmentCenter;

  /** normalized qualification key (the same key the simulation uses) */
  @Index('IDX_center_qualification_slots_key')
  @Column({ name: 'qualification_key' })
  qualificationKey: string;

  @Column({ name: 'qualification_id', type: 'int', nullable: true })
  qualificationId: number | null;

  @ManyToOne(() => Qualification, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'qualification_id' })
  qualificationRef?: Qualification;

  /** display name, e.g. "Cookery II" */
  @Column()
  qualification: string;

  /** 00:00 Asia/Manila on the 1st of the month, epoch seconds */
  @Index('IDX_center_qualification_slots_month')
  @Column({ name: 'month_start', type: 'bigint', transformer: epochTransformer })
  monthStart: number;

  @Column({ type: 'int' })
  slots: number;

  /** 'demo' | 'tesda' | 'ncr' */
  @Column({ default: 'demo' })
  source: string;

  @Column({ name: 'as_of', type: 'bigint', transformer: epochTransformer })
  asOf: number;
}

/** One run of the TESDA API sync. */
@Entity({ name: 'tesda_syncs' })
export class TesdaSync {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'started_at', type: 'bigint', transformer: epochTransformer, default: () => EPOCH_NOW_SQL })
  startedAt: number;

  @Column({ name: 'finished_at', type: 'bigint', nullable: true, transformer: epochTransformer })
  finishedAt: number | null;

  /** RUNNING | COMPLETED | FAILED */
  @Column()
  status: string;

  @Column({ name: 'triggered_by' })
  triggeredBy: string;

  /** when TESDA last recalculated its data (GET /api/v1/coverage/run) */
  @Column({ name: 'tesda_run_at', type: 'bigint', nullable: true, transformer: epochTransformer })
  tesdaRunAt: number | null;

  @Column({ type: 'jsonb', nullable: true })
  stats: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;
}
