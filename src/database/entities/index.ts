import { City, Province, Region } from './geography.entity';
import {
  AssessmentCenter,
  CenterQualification,
  CenterQualificationSlot,
  TesdaSync,
  UpcomingGraduates,
} from './t2mis.entity';
import { User } from './user.entity';
import { Proposal } from './proposal.entity';
import { AreaUtilization, CenterUtilization, SimulationRun } from './simulation.entity';
import { ForecastPlace, ForecastRun, ForecastValue } from './forecast.entity';

export * from './enums';
export * from './geography.entity';
export * from './t2mis.entity';
export * from './user.entity';
export * from './proposal.entity';
export * from './simulation.entity';
export * from './forecast.entity';

export const ENTITIES = [
  Region,
  Province,
  City,
  AssessmentCenter,
  CenterQualification,
  CenterQualificationSlot,
  UpcomingGraduates,
  TesdaSync,
  User,
  Proposal,
  SimulationRun,
  AreaUtilization,
  CenterUtilization,
  ForecastRun,
  ForecastPlace,
  ForecastValue,
];
