import { PoolConfig } from 'pg';
import { env } from './env.config';

export function getDatabaseConfig(): PoolConfig {
  const config: PoolConfig = {
    connectionString: env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  };

  // Heroku Postgres requires SSL with self-signed certs
  if (env.NODE_ENV === 'production') {
    config.ssl = { rejectUnauthorized: false };
  }

  return config;
}
