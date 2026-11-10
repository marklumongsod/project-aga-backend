import { City, Province, Region } from './geography.entity';
import {
  AssessmentCenter,
  CenterQualification,
  Qualification,
  TesdaSync,
  UpcomingGraduates,
} from './t2mis.entity';
import { BsrsStat } from './demand.entity';
import { User } from './user.entity';
import { Proposal } from './proposal.entity';
import { AreaUtilization, CenterUtilization, SimulationRun } from './simulation.entity';

export * from './enums';
export * from './geography.entity';
export * from './t2mis.entity';
export * from './demand.entity';
export * from './user.entity';
export * from './proposal.entity';
export * from './simulation.entity';

export const ENTITIES = [
  Region,
  Province,
  City,
  Qualification,
  AssessmentCenter,
  CenterQualification,
  UpcomingGraduates,
  TesdaSync,
  BsrsStat,
  User,
  Proposal,
  SimulationRun,
  AreaUtilization,
  CenterUtilization,
];
