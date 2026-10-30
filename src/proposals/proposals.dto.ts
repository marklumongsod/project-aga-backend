import { ApiProperty } from '@nestjs/swagger';
import { WhatIfResultDto } from '../simulation/simulation.dto';

/** A saved what-if, as listed. The full result is on `GET /proposals/:id`. */
export class ProposalSummaryDto {
  id: string;
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
