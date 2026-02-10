import { PoolConfig } from 'pg';
import { env } from './env.config';
import { logger } from './logger.config';

export function getDatabaseConfig(): PoolConfig {
  const config: PoolConfig = {
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_SIZE || 20, // Configurable pool size (default: 20)
    min: 2, // Keep 2 connections warm
    idleTimeoutMillis: 30000, // Close idle connections after 30s
    connectionTimeoutMillis: 5000, // 5s to acquire connection from pool
    statement_timeout: 30000, // 30s max query time (prevent runaway queries)
    idle_in_transaction_session_timeout: 60000, // 60s max idle time within transaction
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
      logger.warn(
        '[SECURITY] Database SSL certificate validation is disabled. ' +
          'Set DATABASE_SSL_REJECT_UNAUTHORIZED=true for non-Heroku deployments.'
      );
    }
  }

  return config;
}
