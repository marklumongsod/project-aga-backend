import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';
import { WhatIfResultDto } from '../simulation/simulation.dto';

/** A saved what-if, as listed. The full result is on `GET /proposals/:id`. */
export class ProposalSummaryDto {
  id: string;
  /** short report number, shown as RPT-0001 */
  reportNo: number;
  name: string;
  /** the city or municipality the pin landed in */
  cityKey: string | null;
  cityName: string | null;
  lat: number;
  lon: number;
  /** the area the result is reported on */
  areaLevel: string;
  areaCode: string;
  areaName: string;
  limitMinutes: number;
  status: string;
  authorName: string;
  authorRole: string;
  /** the author's name parts from T2MIS SSO (null for other accounts), for "Prepared by: Surname, First Name MI" */
  authorFirstName: string | null;
  authorMiddleName: string | null;
  authorLastName: string | null;
  /** the author's office area: the province (PO) or region (RO); null for CO */
  authorAreaName: string | null;
  /** epoch seconds */
  createdAt: number;
  /** candidates who get a center in reach (nationwide) */
  newlyServed: number;
  /** assessment desert cities closed in the area */
  desertCitiesClosed: number;
  flaggedShareBefore: number;
  flaggedShareAfter: number;
  /** saved by the signed-in user */
  mine: boolean;
}

export class ProposalDto extends ProposalSummaryDto {
  /** the what-if result worked out by the server when the proposal was saved */
  @ApiProperty({ type: () => WhatIfResultDto })
  result: WhatIfResultDto;
}

/** Rename a saved proposal (the report's name). */
export class RenameProposalDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 120)
  name: string;
}
