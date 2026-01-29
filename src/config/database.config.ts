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

  // SSL configuration for production
  // SECURITY NOTE: rejectUnauthorized: false is required for Heroku Postgres
  // because Heroku uses self-signed certificates that change periodically.
  // For non-Heroku deployments, set DATABASE_SSL_REJECT_UNAUTHORIZED=true
  // and provide proper CA certificates.
  if (env.NODE_ENV === 'production') {
    const rejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true';
    config.ssl = {
      rejectUnauthorized,
      // If using proper certificates, you can add:
      // ca: process.env.DATABASE_SSL_CA,
    };

    if (!rejectUnauthorized) {
      console.warn(
        '[SECURITY] Database SSL certificate validation is disabled. ' +
          'Set DATABASE_SSL_REJECT_UNAUTHORIZED=true for non-Heroku deployments.'
      );
    }
  }

  return config;
}
