import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `now()::bigint` rounds (100.7 -> 101) but the application truncates (Math.floor). A run could then finish one
 * second "before" it started. Truncate in the database too, so every writer produces the same epoch second.
 */
const FLOOR_NOW = '(FLOOR(EXTRACT(EPOCH FROM now())))::bigint';
const ROUND_NOW = '(EXTRACT(EPOCH FROM now()))::bigint';
const COLUMNS: Array<[string, string]> = [
  ['simulation_runs', 'started_at'],
  ['travel_times', 'computed_at'],
  ['users', 'created_at'],
  ['users', 'updated_at'],
  ['center_recovery_log', 'applied_at'],
];

export class EpochFloor1792600000006 implements MigrationInterface {
  name = 'EpochFloor1792600000006';

  public async up(q: QueryRunner): Promise<void> {
    for (const [t, c] of COLUMNS) await q.query(`ALTER TABLE "${t}" ALTER COLUMN "${c}" SET DEFAULT ${FLOOR_NOW}`);
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const [t, c] of COLUMNS) await q.query(`ALTER TABLE "${t}" ALTER COLUMN "${c}" SET DEFAULT ${ROUND_NOW}`);
  }
}
