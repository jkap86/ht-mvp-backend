import { Pool } from 'pg';
import { getDatabaseConfig } from '../config/database.config';
import { logger } from '../config/logger.config';
import { getQueryContext } from '../shared/query-context';

// Slow query thresholds in milliseconds (configurable via env)
const SLOW_QUERY_THRESHOLD_MS = parseInt(process.env.SLOW_QUERY_THRESHOLD_MS || '200', 10);
const VERY_SLOW_QUERY_THRESHOLD_MS = parseInt(process.env.VERY_SLOW_QUERY_THRESHOLD_MS || '1000', 10);

// Create database connection pool
export const pool = new Pool(getDatabaseConfig());

// Pool metrics function
export function getPoolMetrics() {
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  };
}

// Wrap pool.query to measure timing and log slow queries with context
const originalQuery = pool.query.bind(pool);
(pool as any).query = async function (text: string | any, params?: any[]) {
  const start = Date.now();
  const context = getQueryContext();

  try {
    return await originalQuery(text, params);
  } finally {
    const duration = Date.now() - start;
    const queryText = typeof text === 'string' ? text : text.text;

    if (duration > SLOW_QUERY_THRESHOLD_MS) {
      const logData = {
        durationMs: duration,
        query: queryText?.substring(0, 200),
        requestId: context.requestId,
        userId: context.userId,
        jobName: context.jobName,
        label: context.label,
      };

      if (duration > VERY_SLOW_QUERY_THRESHOLD_MS) {
        logger.error('Very slow query detected', logData);
      } else {
        logger.warn('Slow query detected', logData);
      }
    }
  }
};

// Log connection events in development
pool.on('connect', () => {
  if (process.env.NODE_ENV === 'development') {
    logger.debug('Database client connected');
  }
});

pool.on('error', (err) => {
  logger.error('Unexpected database error', { error: err.message });
});

// Health check function
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    const result = await pool.query('SELECT 1 as health_check');
    return result.rows[0].health_check === 1;
  } catch (error) {
    logger.error('Database health check failed', { error: String(error) });
    return false;
  }
}

// Graceful shutdown
export async function closePool(): Promise<void> {
  await pool.end();
  logger.info('Database pool closed');
}

// Development pool pressure monitoring
if (process.env.NODE_ENV === 'development') {
  setInterval(() => {
    const metrics = getPoolMetrics();
    if (metrics.waitingCount > 0) {
      logger.warn('Pool pressure detected', metrics);
    }
  }, 30000);
}
