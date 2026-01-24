import { PoolConfig } from 'pg';
import { env } from './env.config';

export function getDatabaseConfig(): PoolConfig {
  return {
    connectionString: env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  };
}
