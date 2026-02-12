import { Pool, QueryResult, QueryResultRow } from 'pg';
import { getDatabaseConfig } from '../config/database.config';
import { logger } from '../config/logger.config';
import { getQueryContext } from '../shared/query-context';

// Pool health states for circuit breaker
export enum PoolHealth {
  HEALTHY = 'healthy', // < 70% capacity
  DEGRADED = 'degraded', // 70-90% capacity or waitingCount > 0
  CRITICAL = 'critical', // > 95% capacity or waitingCount > 5
}

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

// Determine current pool health for circuit breaker decisions
export function getPoolHealth(): PoolHealth {
  const total = pool.totalCount;
  const idle = pool.idleCount;
  const waiting = pool.waitingCount;
  const usage = total > 0 ? (total - idle) / total : 0;

  if (waiting > 5 || usage > 0.95) return PoolHealth.CRITICAL;
  if (waiting > 0 || usage > 0.7) return PoolHealth.DEGRADED;
  return PoolHealth.HEALTHY;
}

// Wrap pool.query to measure timing and log slow queries with context
const originalQuery = pool.query.bind(pool);

// Create a type-safe wrapper function
// Note: The assignment to pool.query requires a cast because Pool.query has multiple overloads
// (callback-style, promise-style, streaming, etc.) that are difficult to replicate exactly.
// However, the wrapper function itself is properly typed for the promise-based usage we actually use.
async function queryWithLogging<T extends QueryResultRow = any>(
  text: string | { text: string; values?: any[] },
  params?: any[]
): Promise<QueryResult<T>> {
  const start = Date.now();
  const context = getQueryContext();

  try {
    return await originalQuery<T>(text, params);
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
}

// Override pool.query with our logging wrapper
// SAFETY: This cast is required because Pool.query has 10+ overloads including callback-style variants.
// Our wrapper covers the promise-based overloads that the codebase actually uses.
// The wrapper function itself maintains full type safety with generics.
(pool as any).query = queryWithLogging;

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

// Track monitoring interval for cleanup
let monitoringInterval: NodeJS.Timeout | null = null;

// Graceful shutdown
export async function closePool(): Promise<void> {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
  }
  pool.removeAllListeners();
  await pool.end();
  logger.info('Database pool closed');
}

// Pool pressure monitoring (all environments)
monitoringInterval = setInterval(() => {
  const health = getPoolHealth();
  if (health !== PoolHealth.HEALTHY) {
    const metrics = getPoolMetrics();
    logger.warn('Pool pressure detected', { health, ...metrics });
  }
}, 30000);
