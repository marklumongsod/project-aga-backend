import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { AreaLevel, RunStatus } from './enums';
import { AssessmentCenter } from './t2mis.entity';
import { EPOCH_NOW_SQL, epochTransformer } from '../epoch';

export interface RunSummary {
  candidates: number;
  /** candidates with no center in reach (all candidates of the desert cities) */
  flagged: number;
  centers: number;
  /** flagged / candidates */
  flaggedShare: number;
  assumptions: Record<string, string | number>;
}

@Entity({ name: 'simulation_runs' })
@Index('IDX_simulation_runs_status_finished', ['status', 'finishedAt'])
export class SimulationRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: RunStatus, enumName: 'run_status', default: RunStatus.RUNNING })
  status: RunStatus;

  @Column({ name: 'limit_minutes', type: 'int' })
  limitMinutes: number;

  @Column({ name: 'travel_model' })
  travelModel: string;

  @Column({ type: 'jsonb', nullable: true })
  summary: RunSummary | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  /** user id, or "scheduler" */
  @Column({ name: 'triggered_by', type: 'varchar', nullable: true })
  triggeredBy: string | null;

  /** a one-off run for a custom travel limit (?limitMinutes=); not history, expires, see SimulationService */
  @Column({ type: 'boolean', default: false })
  adhoc: boolean;

  /** a one-off run limited to one qualification (`qualificationKey`); null = every qualification */
  @Column({ name: 'qualification_key', type: 'varchar', nullable: true })
  qualificationKey: string | null;

  @Column({ name: 'started_at', type: 'bigint', default: () => EPOCH_NOW_SQL, transformer: epochTransformer })
  startedAt: number;

  @Column({ name: 'finished_at', type: 'bigint', nullable: true, transformer: epochTransformer })
  finishedAt: number | null;

  @OneToMany(() => AreaUtilization, (a) => a.run)
  areaResults?: AreaUtilization[];
}

@Entity({ name: 'area_utilization' })
@Unique(['runId', 'level', 'areaKey'])
@Index(['runId', 'level', 'parentKey'])
export class AreaUtilization {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'run_id', type: 'uuid' })
  runId: string;

  @ManyToOne(() => SimulationRun, (r) => r.areaResults, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'run_id' })
  run?: SimulationRun;

  @Column({ type: 'enum', enum: AreaLevel, enumName: 'area_level' })
  level: AreaLevel;

  /** "PH", region/province PSGC, or city key */
  @Column({ name: 'area_key' })
  areaKey: string;

  @Column({ name: 'parent_key', type: 'varchar', nullable: true })
  parentKey: string | null;

  @Column({ type: 'int' })
  candidates: number;

  @Column({ type: 'int' })
  flagged: number;

  @Column({ type: 'int' })
  centers: number;

  /** flagged / candidates */
  @Column({ name: 'flagged_share', type: 'double precision' })
  flaggedShare: number;

  /** cities: assessment desert level 1-4 by candidates, 0 = not a desert; larger areas: the highest level inside */
  @Column({ name: 'desert_level', type: 'smallint', default: 0 })
  desertLevel: number;

  /** desert cities inside this area (a city counts itself) */
  @Column({ name: 'desert_cities', type: 'int', default: 0 })
  desertCities: number;

  /** candidates living in those desert cities */
  @Column({ name: 'desert_candidates', type: 'int', default: 0 })
  desertCandidates: number;

  /** candidates in this area that are an even share of a larger total (filled in), not a count */
  @Column({ name: 'estimated_candidates', type: 'int', default: 0 })
  estimatedCandidates: number;

  /** cities: minutes to the nearest reachable center; null = none within the travel limits */
  @Column({ name: 'nearest_minutes', type: 'real', nullable: true })
  nearestMinutes: number | null;
}

@Entity({ name: 'center_utilization' })
export class CenterUtilization {
  @PrimaryColumn({ name: 'run_id', type: 'uuid' })
  runId: string;

  @PrimaryColumn({ name: 'center_id', type: 'int' })
  centerId: number;

  @ManyToOne(() => SimulationRun, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'run_id' })
  run?: SimulationRun;

  @ManyToOne(() => AssessmentCenter)
  @JoinColumn({ name: 'center_id' })
  center?: AssessmentCenter;

  /** predicted candidates: those whose nearest reachable center is this one */
  @Column({ type: 'int' })
  demand: number;
}
