import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { EPOCH_NOW_SQL, epochTransformer } from '../epoch';
import { User } from './user.entity';

/**
 * One New Assessment Center Model prediction. Stored for audit and for comparing model versions:
 * the same planning input can have rows from `new-center-v1`, `new-center-v2`, etc.
 */
@Entity({ name: 'new_center_predictions' })
@Index('IDX_new_center_predictions_user', ['requestedBy'])
@Index('IDX_new_center_predictions_province', ['provincePsgc'])
@Index('IDX_new_center_predictions_created', ['createdAt'])
export class NewCenterPrediction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'requested_by', type: 'uuid' })
  requestedBy: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'requested_by' })
  user?: User;

  @Column({ name: 'model_version' })
  modelVersion: string;

  /** last complete month of the raw data the model used */
  @Column({ name: 'last_month', type: 'bigint', transformer: epochTransformer })
  lastMonth: number;

  /** month the planned center opens */
  @Index('IDX_new_center_predictions_accreditation')
  @Column({ name: 'accreditation_month', type: 'bigint', transformer: epochTransformer })
  accreditationMonth: number;

  @Column({ name: 'province_psgc', type: 'char', length: 10 })
  provincePsgc: string;

  /** backend request + raw model input */
  @Column({ type: 'jsonb' })
  input: unknown;

  /** chance, first-year total and 12 monthly rows */
  @Column({ type: 'jsonb' })
  result: unknown;

  @Column({ name: 'created_at', type: 'bigint', default: () => EPOCH_NOW_SQL, transformer: epochTransformer })
  createdAt: number;
}
