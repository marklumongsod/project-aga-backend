import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';
import type { Point } from 'geojson';
import { City } from './geography.entity';
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

/** Graduates finishing training at a school in a month (Asia/Manila month start, epoch seconds). Counts only. */
@Entity({ name: 'school_graduates' })
export class SchoolGraduates {
  @PrimaryColumn({ name: 'school_id', type: 'int' })
  schoolId: number;

  @Index()
  @PrimaryColumn({ type: 'bigint', transformer: epochTransformer })
  month: number;

  @Column({ name: 'school_name', type: 'varchar', nullable: true })
  schoolName: string | null;

  @Column({ name: 'province_name', type: 'varchar', nullable: true })
  provinceName: string | null;

  @Column({ type: 'double precision' })
  lat: number;

  @Column({ type: 'double precision' })
  lon: number;

  @Column({ name: 'city_id', type: 'int', nullable: true })
  cityId: number | null;

  @ManyToOne(() => City, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'city_id' })
  city?: City;

  @Column({ type: 'int' })
  graduates: number;
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
