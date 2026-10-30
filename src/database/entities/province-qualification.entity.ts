import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Graduates of one qualification in one province, summed over the years in the team's graduate list. Counts only. */
@Entity({ name: 'province_qualification_graduates' })
export class ProvinceQualification {
  @PrimaryColumn({ name: 'province_psgc', type: 'char', length: 10 })
  provincePsgc: string;

  /** the T2MIS qualification id (same ids as `qualifications`) */
  @PrimaryColumn({ name: 'qualification_id', type: 'int' })
  qualificationId: number;

  /** the qualification as the list names it, e.g. "Driving II" */
  @Column()
  qualification: string;

  @Column({ type: 'int' })
  graduates: number;
}
