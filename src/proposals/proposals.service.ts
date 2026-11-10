import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { Proposal, Role } from '../database/entities';
import { SimulationService } from '../simulation/simulation.service';
import { WhatIfDto, WhatIfResultDto } from '../simulation/simulation.dto';
import { ProposalDto, ProposalSummaryDto, RenameProposalDto } from './proposals.dto';

interface Row extends Proposal {
  authorName: string;
  authorRole: string;
}

const SELECT = `SELECT p.id, p.report_no AS "reportNo", p."name", p.lat, p.lon, p.city_key AS "cityKey", p.city_name AS "cityName",
       p.region_psgc AS "regionPsgc", p.province_psgc AS "provincePsgc", p.area_level AS "areaLevel",
       p.area_code AS "areaCode", p.area_name AS "areaName", p.limit_minutes AS "limitMinutes", p.status,
       p.snapshot, p.created_at AS "createdAt", p.author_id AS "authorId", u.name AS "authorName", u.role AS "authorRole"
  FROM proposals p JOIN users u ON u.id = p.author_id`;

@Injectable()
export class ProposalsService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly sim: SimulationService,
  ) {}

  /** Who may read a proposal: its author, Central Office, and the office whose region or province the pin is in. */
  private canSee(user: AuthUser, p: { authorId: string; regionPsgc: string | null; provincePsgc: string | null }): boolean {
    if (p.authorId === user.id || user.role === Role.CO) return true;
    if (user.role === Role.RO) return !!p.regionPsgc && p.regionPsgc.trim() === user.regionPsgc?.trim();
    return !!p.provincePsgc && p.provincePsgc.trim() === user.provincePsgc?.trim();
  }

  private summary(user: AuthUser, r: Row): ProposalSummaryDto {
    const result = r.snapshot as WhatIfResultDto;
    return {
      id: r.id,
      reportNo: Number(r.reportNo),
      name: r.name,
      cityKey: r.cityKey,
      cityName: r.cityName,
      lat: r.lat,
      lon: r.lon,
      areaLevel: r.areaLevel,
      areaCode: r.areaCode,
      areaName: r.areaName,
      limitMinutes: r.limitMinutes,
      status: r.status,
      authorName: r.authorName,
      authorRole: r.authorRole,
      createdAt: Number(r.createdAt),
      newlyServed: result.newlyServed,
      desertCitiesClosed: result.area.desertCitiesBefore - result.area.desertCitiesAfter,
      flaggedShareBefore: result.area.flaggedShareBefore,
      flaggedShareAfter: result.area.flaggedShareAfter,
      mine: r.authorId === user.id,
    };
  }

  /**
   * Save a proposed center. The what-if is run here, with the same checks as `POST /simulation/what-if` (the pin must
   * be inside the office's area, and inside the area chosen, if any), and that result is what gets stored: a
   * client can't save numbers it made up.
   */
  async create(user: AuthUser, dto: WhatIfDto): Promise<ProposalDto> {
    const result = await this.sim.whatIf(user, dto);
    const [where] = result.pin.cityKey
      ? await this.db.query(`SELECT region_psgc, province_psgc FROM cities WHERE key = $1`, [result.pin.cityKey])
      : [];
    const name = (dto.name?.trim() || `New center in ${result.pin.cityName ?? 'selected location'}`).slice(0, 120);
    const [{ id }] = await this.db.query(
      `INSERT INTO proposals (author_id, name, lat, lon, city_key, city_name, region_psgc, province_psgc,
                              area_level, area_code, area_name, limit_minutes, snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING id`,
      [
        user.id,
        name,
        dto.lat,
        dto.lon,
        result.pin.cityKey,
        result.pin.cityName,
        where?.region_psgc ?? null,
        where?.province_psgc ?? null,
        result.area.level,
        result.area.code,
        result.area.name,
        result.limitMinutes,
        JSON.stringify(result),
      ],
    );
    return this.get(user, id);
  }

  async list(user: AuthUser): Promise<ProposalSummaryDto[]> {
    const rows: Row[] = await this.db.query(`${SELECT} ORDER BY p.created_at DESC LIMIT 200`);
    return rows.filter((r) => this.canSee(user, r)).map((r) => this.summary(user, r));
  }

  async get(user: AuthUser, id: string): Promise<ProposalDto> {
    const [r]: Row[] = await this.db.query(`${SELECT} WHERE p.id = $1`, [id]);
    // not found and not allowed look the same, so ids can't be probed
    if (!r || !this.canSee(user, r)) throw new NotFoundException('Proposal not found');
    return { ...this.summary(user, r), result: r.snapshot as WhatIfResultDto };
  }

  /** Rename (the report's name). Same rule as delete: the author, or Central Office. */
  async rename(user: AuthUser, id: string, dto: RenameProposalDto): Promise<ProposalSummaryDto> {
    const [r]: Row[] = await this.db.query(`${SELECT} WHERE p.id = $1`, [id]);
    if (!r || !this.canSee(user, r)) throw new NotFoundException('Proposal not found');
    if (r.authorId !== user.id && user.role !== Role.CO) throw new ForbiddenException('Only the author or Central Office can rename a proposal');
    await this.db.query(`UPDATE proposals SET name = $2 WHERE id = $1`, [id, dto.name]);
    return this.summary(user, { ...r, name: dto.name });
  }

  /** The author may delete their own; Central Office may delete any. */
  async remove(user: AuthUser, id: string): Promise<void> {
    const [r]: Row[] = await this.db.query(`${SELECT} WHERE p.id = $1`, [id]);
    if (!r || !this.canSee(user, r)) throw new NotFoundException('Proposal not found');
    if (r.authorId !== user.id && user.role !== Role.CO) throw new ForbiddenException('Only the author or Central Office can delete a proposal');
    await this.db.query(`DELETE FROM proposals WHERE id = $1`, [id]);
  }
}
