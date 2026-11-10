import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { EPOCH_NOW_SQL, epochTransformer } from '../epoch';
import { User } from './user.entity';

/**
 * A saved what-if: a proposed assessment center with the result the server worked out when it was saved
 * (never one sent by the client). Visible to its author, to Central Office, and to the regional or provincial
 * office whose area the pin is in.
 */
@Entity({ name: 'proposals' })
export class Proposal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** short report number (RPT-0001 on the Reports page), assigned in save order */
  @Column({ name: 'report_no', type: 'integer', generatedIdentity: 'BY DEFAULT', unique: true })
  reportNo: number;

  @Index('IDX_proposals_author')
  @Column({ name: 'author_id', type: 'uuid' })
  authorId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'author_id' })
  author?: User;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'double precision' })
  lat: number;

  @Column({ type: 'double precision' })
  lon: number;

  /** the city or municipality the pin landed in */
  @Column({ name: 'city_key', type: 'varchar', nullable: true })
  cityKey: string | null;

  @Column({ name: 'city_name', type: 'varchar', nullable: true })
  cityName: string | null;

  /** where the pin landed: decides which offices may see it */
  @Index('IDX_proposals_region')
  @Column({ name: 'region_psgc', type: 'char', length: 10, nullable: true })
  regionPsgc: string | null;

  @Index('IDX_proposals_province')
  @Column({ name: 'province_psgc', type: 'char', length: 10, nullable: true })
  provincePsgc: string | null;

  /** the area the result is reported on (the author's home area, or the region or province they chose) */
  @Column({ name: 'area_level', type: 'varchar' })
  areaLevel: string;

  @Column({ name: 'area_code', type: 'varchar' })
  areaCode: string;

  @Column({ name: 'area_name', type: 'varchar' })
  areaName: string;

  @Column({ name: 'limit_minutes', type: 'int' })
  limitMinutes: number;

  @Column({ type: 'varchar', default: 'SAVED' })
  status: string;

  /** the what-if result at the time of saving */
  @Column({ type: 'jsonb' })
  snapshot: unknown;

  @Column({ name: 'created_at', type: 'bigint', default: () => EPOCH_NOW_SQL, transformer: epochTransformer })
  createdAt: number;
}
