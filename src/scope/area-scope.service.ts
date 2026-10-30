import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { AreaLevel, Role } from '../database/entities';

export interface AreaRef {
  level: AreaLevel;
  /** "PH" for national, otherwise a region / province PSGC or a city key */
  code: string;
  name: string;
}

export const NATIONAL: AreaRef = { level: AreaLevel.NATIONAL, code: 'PH', name: 'Philippines' };

/**
 * Role scoping:
 *   CO - any area
 *   RO - their region and anything inside it
 *   PO - their province and anything inside it
 */
@Injectable()
export class AreaScopeService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /** The area a user lands on: PH for CO, own region for RO, own province for PO. */
  async home(user: AuthUser): Promise<AreaRef> {
    if (user.role === Role.CO) return NATIONAL;
    if (user.role === Role.RO) return this.describe(AreaLevel.REGION, user.regionPsgc!);
    return this.describe(AreaLevel.PROVINCE, user.provincePsgc!);
  }

  /** Resolve the requested area (or the user's home) and check the user may see it. */
  async resolve(user: AuthUser, level?: AreaLevel, code?: string): Promise<AreaRef> {
    if (!level) return this.home(user);
    if (level === AreaLevel.NATIONAL) {
      if (user.role !== Role.CO)
        throw new ForbiddenException('Only Central Office can view the national level');
      return NATIONAL;
    }
    if (!code) throw new BadRequestException('code is required for this level');
    const area = await this.describe(level, code);
    await this.assertAllowed(user, area);
    return area;
  }

  async assertAllowed(user: AuthUser, area: AreaRef): Promise<void> {
    if (user.role === Role.CO) return;
    const { regionPsgc, provincePsgc } = await this.parents(area);
    if (user.role === Role.RO && regionPsgc === user.regionPsgc) return;
    if (user.role === Role.PO && provincePsgc === user.provincePsgc) return;
    throw new ForbiddenException('This area is outside your office scope');
  }

  /** Is a point inside the user's area? (drag-and-drop pins) */
  async pointAllowed(user: AuthUser, lat: number, lon: number): Promise<boolean> {
    const [table, code] =
      user.role === Role.CO
        ? ['regions', null]
        : user.role === Role.RO
          ? ['regions', user.regionPsgc]
          : ['provinces', user.provincePsgc];
    const rows = await this.db.query(
      `SELECT 1 FROM ${table} WHERE ($1::text IS NULL OR psgc = $1)
         AND ST_Intersects(geom, ST_Buffer(ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, 500)::geometry) LIMIT 1`,
      [code, lon, lat],
    );
    return rows.length > 0;
  }

  /** Is a point inside one given region or province (with the same 500 m shore allowance)? */
  async pointInArea(area: AreaRef, lat: number, lon: number): Promise<boolean> {
    if (area.level === AreaLevel.NATIONAL) return true;
    const table = area.level === AreaLevel.REGION ? 'regions' : 'provinces';
    const rows = await this.db.query(
      `SELECT 1 FROM ${table} WHERE psgc = $1
         AND ST_Intersects(geom, ST_Buffer(ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, 500)::geometry) LIMIT 1`,
      [area.code, lon, lat],
    );
    return rows.length > 0;
  }

  async describe(level: AreaLevel, code: string): Promise<AreaRef> {
    if (level === AreaLevel.NATIONAL) return NATIONAL;
    const sql = {
      [AreaLevel.REGION]: `SELECT psgc AS code, name FROM regions WHERE psgc = $1`,
      [AreaLevel.PROVINCE]: `SELECT psgc AS code, name FROM provinces WHERE psgc = $1`,
      [AreaLevel.CITY]: `SELECT key AS code, name FROM cities WHERE key = $1`,
    }[level];
    const [row] = await this.db.query(sql, [code]);
    if (!row) throw new NotFoundException(`${level.toLowerCase()} ${code} not found`);
    return { level, code: row.code, name: row.name };
  }

  private async parents(area: AreaRef): Promise<{ regionPsgc: string | null; provincePsgc: string | null }> {
    if (area.level === AreaLevel.REGION) return { regionPsgc: area.code, provincePsgc: null };
    if (area.level === AreaLevel.PROVINCE) {
      const [p] = await this.db.query(`SELECT region_psgc FROM provinces WHERE psgc = $1`, [area.code]);
      return { regionPsgc: p?.region_psgc ?? null, provincePsgc: area.code };
    }
    if (area.level === AreaLevel.CITY) {
      const [c] = await this.db.query(`SELECT region_psgc, province_psgc FROM cities WHERE key = $1`, [
        area.code,
      ]);
      return { regionPsgc: c?.region_psgc ?? null, provincePsgc: c?.province_psgc ?? null };
    }
    return { regionPsgc: null, provincePsgc: null };
  }
}
