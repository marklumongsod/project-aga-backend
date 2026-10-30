import 'dotenv/config';
import { DataSource, DataSourceOptions } from 'typeorm';
import { ENTITIES } from './entities';

/** Shared TypeORM options (app + CLI). Schema changes go through migrations only. */
export function typeormOptions(url = process.env.DATABASE_URL): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    entities: ENTITIES,
    migrations: [__dirname + '/migrations/*.{ts,js}'],
    synchronize: false,
    migrationsRun: false,
    logging: ['error', 'warn'],
  };
}

/** Used by the TypeORM CLI: npm run db:migrate / db:revert */
export default new DataSource(typeormOptions());
