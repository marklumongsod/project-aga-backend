import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { EPOCH_NOW_SQL, epochTransformer } from '../epoch';

/**
 * One monthly forecast import. The Python/LightGBM job runs outside the API and writes an aggregate JSON;
 * this table records the run and the `forecast_values` hold its rows.
 */
@Entity({ name: 'forecast_runs' })
@Unique('UQ_forecast_runs', ['forecastMonth', 'modelVersion'])
@Index('IDX_forecast_runs_month', ['forecastMonth'])
export class ForecastRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** last complete assessment month, epoch seconds of 00:00 Asia/Manila on the 1st */
  @Column({ name: 'forecast_month', type: 'bigint', transformer: epochTransformer })
  forecastMonth: number;

  /** when the Python job produced the file */
  @Column({ name: 'generated_at', type: 'bigint', transformer: epochTransformer })
  generatedAt: number;

  @Column({ name: 'imported_at', type: 'bigint', default: () => EPOCH_NOW_SQL, transformer: epochTransformer })
  importedAt: number;

  /** hash/version of the model artifact that produced this run */
  @Column({ name: 'model_version' })
  modelVersion: string;

  /** 0.2 for the current 20% sample; 1 when the data team retrains on full data */
  @Column({ name: 'sample_rate', type: 'double precision', default: 0.2 })
  sampleRate: number;

  /** raw rows in the source JSON (before mapping/splitting) */
  @Column({ name: 'row_count', type: 'int' })
  rowCount: number;

  @Column({ name: 'source_file', type: 'varchar', nullable: true })
  sourceFile: string | null;

  /** model metadata: trained_on, test_accuracy, package versions */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @OneToMany(() => ForecastValue, (v) => v.run)
  values?: ForecastValue[];
}

/**
 * Raw T2MIS place -> backend area. A row is written by the importer from `forecast_places.csv`.
 * `source_place_id` is a raw RegionId, ProvinceId or CenterId; `target_code` is a PSGC or a center id.
 * A split source (for example old Maguindanao) has multiple non-excluded rows whose shares sum to 1.
 */
@Entity({ name: 'forecast_places' })
@Unique('UQ_forecast_places', ['level', 'sourcePlaceId', 'targetType', 'targetCode'])
@Index('IDX_forecast_places_source', ['level', 'sourcePlaceId'])
export class ForecastPlace {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  level: string;

  @Column({ name: 'source_place_id' })
  sourcePlaceId: string;

  @Column({ name: 'parent_source_id', type: 'varchar', nullable: true })
  parentSourceId: string | null;

  @Column({ type: 'varchar', nullable: true })
  name: string | null;

  /** national | region | province | center | excluded */
  @Column({ name: 'target_type' })
  targetType: string;

  @Column({ name: 'target_code' })
  targetCode: string;

  @Column({ type: 'double precision', default: 1 })
  share: number;

  @Column({ type: 'varchar', nullable: true })
  note: string | null;
}

/**
 * One forecast row, already mapped to a PSGC or center. For split places there is one row per target and
 * `share` is applied when the API sums. `forecast_real` is the raw model value (not multiplied by share).
 */
@Entity({ name: 'forecast_values' })
@Unique('UQ_forecast_values', ['runId', 'level', 'sourcePlaceId', 'targetMonth', 'horizon', 'targetType', 'targetCode'])
@Index('IDX_forecast_values_region', ['runId', 'level', 'regionPsgc', 'targetMonth'])
@Index('IDX_forecast_values_province', ['runId', 'level', 'provincePsgc', 'targetMonth'])
@Index('IDX_forecast_values_center', ['runId', 'level', 'centerId', 'targetMonth'])
export class ForecastValue {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ name: 'run_id', type: 'uuid' })
  runId: string;

  @ManyToOne(() => ForecastRun, (r) => r.values, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'run_id' })
  run?: ForecastRun;

  @Column()
  level: string;

  @Column({ name: 'source_place_id' })
  sourcePlaceId: string;

  @Column({ name: 'parent_source_id', type: 'varchar', nullable: true })
  parentSourceId: string | null;

  /** national | region | province | center */
  @Column({ name: 'target_type' })
  targetType: string;

  @Column({ name: 'target_code' })
  targetCode: string;

  /** target month, epoch seconds of 00:00 Asia/Manila on the 1st */
  @Column({ name: 'target_month', type: 'bigint', transformer: epochTransformer })
  targetMonth: number;

  @Column({ type: 'smallint' })
  horizon: number;

  @Column({ name: 'forecast_sample', type: 'double precision' })
  forecastSample: number;

  @Column({ name: 'forecast_real', type: 'double precision' })
  forecastReal: number;

  @Column({ type: 'double precision', default: 1 })
  share: number;

  @Column({ name: 'region_psgc', type: 'char', length: 10, nullable: true })
  regionPsgc: string | null;

  @Column({ name: 'province_psgc', type: 'char', length: 10, nullable: true })
  provincePsgc: string | null;

  @Column({ name: 'center_id', type: 'int', nullable: true })
  centerId: number | null;
}
