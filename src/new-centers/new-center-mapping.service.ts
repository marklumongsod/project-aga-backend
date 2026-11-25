import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'fs';
import { qualificationKey } from '../simulation/qualification-need';
import { parseCsv } from './csv';

export interface ProvinceMapping {
  rawProvinceId: number;
  rawProvinceName: string;
}

export interface QualificationMapping {
  rawQualId: number;
  rawTitle: string;
  rawLevel: number | null;
}

/**
 * Backend PSGC/qualification -> raw T2MIS IDs used by the New Center Model.
 *
 * The CSVs are generated from the raw `Qualification.xlsx` and the backend geography by
 * `scripts/new-centers/build-maps.py`. They contain names and IDs only, no learner data.
 */
@Injectable()
export class NewCenterMappingService implements OnModuleInit {
  private readonly log = new Logger(NewCenterMappingService.name);
  private provinces = new Map<string, ProvinceMapping>();
  private qualifications = new Map<string, QualificationMapping>();

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const provincePath = this.config.get<string>('NEW_CENTER_PROVINCE_MAP', 'docs/new-centers/province_map.csv');
    const qualificationPath = this.config.get<string>(
      'NEW_CENTER_QUALIFICATION_MAP',
      'docs/new-centers/qualification_map.csv',
    );
    this.provinces = this.load(provincePath, 'province');
    this.qualifications = this.loadQualifications(qualificationPath);
    this.log.log(
      `new center mapping: ${this.provinces.size} provinces, ${this.qualifications.size} qualifications`,
    );
  }

  get available(): boolean {
    return this.provinces.size > 0 && this.qualifications.size > 0;
  }

  get provinceCount(): number {
    return this.provinces.size;
  }

  get qualificationCount(): number {
    return this.qualifications.size;
  }

  province(psgc: string): ProvinceMapping | undefined {
    return this.provinces.get(psgc.trim());
  }

  qualification(nameOrKey: string): QualificationMapping | undefined {
    return this.qualifications.get(qualificationKey(nameOrKey));
  }

  private load(path: string, kind: string): Map<string, ProvinceMapping> {
    const map = new Map<string, ProvinceMapping>();
    try {
      const rows = parseCsv(readFileSync(path, 'utf8'));
      if (rows.length < 2) throw new Error('CSV is empty');
      const header = rows[0].map((h) => h.trim());
      const col = (name: string) => {
        const i = header.indexOf(name);
        if (i < 0) throw new Error(`missing ${name}`);
        return i;
      };
      const psgc = col('province_psgc');
      const rawId = col('raw_province_id');
      const rawName = col('raw_province_name');
      for (const row of rows.slice(1)) {
        if (!row[psgc]) continue;
        map.set(row[psgc].trim(), {
          rawProvinceId: Number(row[rawId]),
          rawProvinceName: row[rawName] ?? '',
        });
      }
    } catch (e) {
      this.log.warn(`could not load ${kind} mapping ${path}: ${(e as Error).message}`);
    }
    return map;
  }

  private loadQualifications(path: string): Map<string, QualificationMapping> {
    const map = new Map<string, QualificationMapping>();
    try {
      const rows = parseCsv(readFileSync(path, 'utf8'));
      if (rows.length < 2) throw new Error('CSV is empty');
      const header = rows[0].map((h) => h.trim());
      const col = (name: string) => {
        const i = header.indexOf(name);
        if (i < 0) throw new Error(`missing ${name}`);
        return i;
      };
      const key = col('qualification_key');
      const rawId = col('raw_qual_id');
      const rawTitle = col('raw_title');
      const rawLevel = col('raw_level');
      for (const row of rows.slice(1)) {
        if (!row[key] || !row[rawId]) continue;
        map.set(row[key].trim(), {
          rawQualId: Number(row[rawId]),
          rawTitle: row[rawTitle] ?? '',
          rawLevel: row[rawLevel] ? Number(row[rawLevel]) : null,
        });
      }
    } catch (e) {
      this.log.warn(`could not load qualification mapping ${path}: ${(e as Error).message}`);
    }
    return map;
  }
}
