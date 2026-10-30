import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { MultiPolygon, Point } from 'geojson';

/** PSGC 2023 region. PSGC codes are 10-character strings (leading zeros kept). */
@Entity({ name: 'regions' })
export class Region {
  @PrimaryColumn({ type: 'char', length: 10 })
  psgc: string;

  @Column()
  name: string;

  @Column({ type: 'geometry', spatialFeatureType: 'MultiPolygon', srid: 4326, nullable: true, select: false })
  geom?: MultiPolygon;

  @OneToMany(() => Province, (p) => p.region)
  provinces?: Province[];
}

@Entity({ name: 'provinces' })
export class Province {
  @PrimaryColumn({ type: 'char', length: 10 })
  psgc: string;

  @Column()
  name: string;

  @Index()
  @Column({ name: 'region_psgc', type: 'char', length: 10 })
  regionPsgc: string;

  @ManyToOne(() => Region, (r) => r.provinces)
  @JoinColumn({ name: 'region_psgc' })
  region?: Region;

  @Column({ type: 'geometry', spatialFeatureType: 'MultiPolygon', srid: 4326, nullable: true, select: false })
  geom?: MultiPolygon;
}

/**
 * City or municipality. Highly urbanized cities missing from the 2023 boundary files are
 * derived (derivedBoundary = true) and carry no PSGC code until one is confirmed.
 */
@Entity({ name: 'cities' })
export class City {
  @PrimaryGeneratedColumn()
  id: number;

  /** PSGC code, or "D-<region>-<name>" for a derived boundary */
  @Index({ unique: true })
  @Column()
  key: string;

  @Index({ unique: true, where: 'psgc IS NOT NULL' })
  @Column({ type: 'char', length: 10, nullable: true })
  psgc: string | null;

  @Column()
  name: string;

  @Index()
  @Column({ name: 'province_psgc', type: 'char', length: 10 })
  provincePsgc: string;

  @ManyToOne(() => Province)
  @JoinColumn({ name: 'province_psgc' })
  province?: Province;

  @Index()
  @Column({ name: 'region_psgc', type: 'char', length: 10 })
  regionPsgc: string;

  @Column({ name: 'derived_boundary', default: false })
  derivedBoundary: boolean;

  /** Land mass id: a trip between different islands needs a ferry. */
  @Column({ name: 'island_id', type: 'int' })
  islandId: number;

  @Column({ type: 'double precision' })
  lat: number;

  @Column({ type: 'double precision' })
  lon: number;

  @Column({ type: 'geometry', spatialFeatureType: 'MultiPolygon', srid: 4326, nullable: true, select: false })
  geom?: MultiPolygon;

  @Column({ type: 'geometry', spatialFeatureType: 'Point', srid: 4326, nullable: true, select: false })
  centroid?: Point;
}
