import { City, Province, Region } from './geography.entity';
import {
  AssessmentCenter,
  CenterQualification,
  Qualification,
  SchoolGraduates,
  TesdaSync,
} from './t2mis.entity';
import { BsrsStat } from './demand.entity';
import { User } from './user.entity';
import { Proposal } from './proposal.entity';
import { ProvinceQualification } from './province-qualification.entity';
import { AreaUtilization, CenterUtilization, SimulationRun } from './simulation.entity';

export * from './enums';
export * from './geography.entity';
export * from './t2mis.entity';
export * from './demand.entity';
export * from './user.entity';
export * from './proposal.entity';
export * from './province-qualification.entity';
export * from './simulation.entity';

export const ENTITIES = [
  Region,
  Province,
  City,
  Qualification,
  AssessmentCenter,
  CenterQualification,
  SchoolGraduates,
  TesdaSync,
  BsrsStat,
  User,
  Proposal,
  ProvinceQualification,
  SimulationRun,
  AreaUtilization,
  CenterUtilization,
];
