import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from '../common/auth.decorators';

const PSGC = /^\d{10}$/;

/** PSGC 2023 areas for filters and map outlines (public). */
@ApiTags('geo')
@Public()
@Controller('geo')
export class GeoController {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  @Get('regions')
  regions() {
    return this.db.query(`SELECT psgc, name FROM regions ORDER BY psgc`);
  }

  @Get('regions/:psgc/provinces')
  provinces(@Param('psgc') psgc: string) {
    if (!PSGC.test(psgc)) throw new NotFoundException();
    return this.db.query(
      `SELECT psgc, name, region_psgc AS "regionPsgc" FROM provinces WHERE region_psgc = $1 ORDER BY name`,
      [psgc],
    );
  }
}
