import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { AreaLevel } from './enums';

/** BSRS scholarship counts per region / province / city (learner demand, no personal data). */
@Entity({ name: 'bsrs_stats' })
@Index(['level', 'regionPsgc'])
export class BsrsStat {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'enum', enum: AreaLevel, enumName: 'area_level' })
  level: AreaLevel;

  @Column({ name: 'source_name' })
  sourceName: string;

  @Column({ name: 'region_psgc', type: 'char', length: 10, nullable: true })
  regionPsgc: string | null;

  @Index()
  @Column({ name: 'province_psgc', type: 'char', length: 10, nullable: true })
  provincePsgc: string | null;

  @Column({ name: 'city_key', type: 'varchar', nullable: true })
  cityKey: string | null;

  /** NCR rows are reported per district (CAMANAVA, PASMAK...): the city keys they cover. */
  @Column({ name: 'city_keys', type: 'text', array: true, default: () => "'{}'" })
  cityKeys: string[];

  @Column({ type: 'int' })
  enrolled: number;

  @Column({ type: 'int' })
  completed: number;

  @Column({ name: 'completion_rate', type: 'double precision' })
  completionRate: number;

  @Column({ name: 'period_label', default: 'cumulative' })
  periodLabel: string;
}
