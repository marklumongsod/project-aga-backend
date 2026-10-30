import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/auth.decorators';
import { WhatIfDto } from '../simulation/simulation.dto';
import { ProposalDto, ProposalSummaryDto } from './proposals.dto';
import { ProposalsService } from './proposals.service';

/** Saved what-ifs for a proposed center. Scoped like the what-if: you see your own and those in your area. */
@ApiTags('proposals')
@ApiBearerAuth()
@Controller('proposals')
export class ProposalsController {
  constructor(private readonly proposals: ProposalsService) {}

  /** Save a proposal. The body is the what-if body (`lat`, `lon`, optional `name`, `level`+`code`, `limitMinutes`). */
  @Post()
  @HttpCode(201)
  create(@CurrentUser() user: AuthUser, @Body() dto: WhatIfDto): Promise<ProposalDto> {
    return this.proposals.create(user, dto);
  }

  /** Newest first: yours, plus those whose pin is in your region (RO) or province (PO); everything for Central Office. */
  @Get()
  list(@CurrentUser() user: AuthUser): Promise<ProposalSummaryDto[]> {
    return this.proposals.list(user);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<ProposalDto> {
    return this.proposals.get(user, id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.proposals.remove(user, id);
  }
}
