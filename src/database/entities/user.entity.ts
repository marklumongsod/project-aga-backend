import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { Role } from './enums';
import { EPOCH_NOW_SQL, epochTransformer } from '../epoch';

/** Office account. Provisioned from T2MIS - there is no self sign-up. */
@Entity({ name: 'users' })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  @Column()
  name: string;

  /** name parts from T2MIS SSO (null for other accounts): reports print "Surname, First Name MI" */
  @Column({ name: 'first_name', type: 'varchar', nullable: true })
  firstName: string | null;

  @Column({ name: 'middle_name', type: 'varchar', nullable: true })
  middleName: string | null;

  @Column({ name: 'last_name', type: 'varchar', nullable: true })
  lastName: string | null;

  /** null for SSO-only accounts */
  @Column({ name: 'password_hash', type: 'varchar', nullable: true, select: false })
  passwordHash: string | null;

  @Column({ name: 't2mis_user_id', type: 'varchar', nullable: true, unique: true })
  t2misUserId: string | null;

  @Column({ type: 'enum', enum: Role, enumName: 'role' })
  role: Role;

  /** RO and PO */
  @Column({ name: 'region_psgc', type: 'char', length: 10, nullable: true })
  regionPsgc: string | null;

  /** PO */
  @Column({ name: 'province_psgc', type: 'char', length: 10, nullable: true })
  provincePsgc: string | null;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @Column({ name: 'last_login_at', type: 'bigint', nullable: true, transformer: epochTransformer })
  lastLoginAt: number | null;

  @Column({ name: 'created_at', type: 'bigint', default: () => EPOCH_NOW_SQL, transformer: epochTransformer })
  createdAt: number;

  @Column({ name: 'updated_at', type: 'bigint', default: () => EPOCH_NOW_SQL, transformer: epochTransformer })
  updatedAt: number;
}
