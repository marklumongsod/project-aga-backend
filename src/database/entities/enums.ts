export enum Role {
  /** Central Office - Planning Office: all regions */
  CO = 'CO',
  /** Regional Office: own region */
  RO = 'RO',
  /** Provincial Office: own province */
  PO = 'PO',
}

export enum AreaLevel {
  NATIONAL = 'NATIONAL',
  REGION = 'REGION',
  PROVINCE = 'PROVINCE',
  CITY = 'CITY',
}

export enum RunStatus {
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}
