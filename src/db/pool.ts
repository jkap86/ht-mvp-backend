import { Pool } from 'pg';
import { getDatabaseConfig } from '../config/database.config';

// Slow query threshold in milliseconds
const SLOW_QUERY_THRESHOLD_MS = 100;

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

// Wrap pool.query to measure timing and log slow queries
const originalQuery = pool.query.bind(pool);
(pool as any).query = async function (text: string | any, params?: any[]) {
  const start = Date.now();
  try {
    return await originalQuery(text, params);
  } finally {
    const duration = Date.now() - start;
    const queryText = typeof text === 'string' ? text : text.text;
    if (duration > SLOW_QUERY_THRESHOLD_MS) {
      console.warn(`Slow query (${duration}ms): ${queryText?.substring(0, 200)}`);
    }
  }
};

// Log connection events in development
pool.on('connect', () => {
  if (process.env.NODE_ENV === 'development') {
    console.log('📦 Database client connected');
  }
});

pool.on('error', (err) => {
  console.error('❌ Unexpected database error:', err.message);
});

// Health check function
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    const result = await pool.query('SELECT 1 as health_check');
    return result.rows[0].health_check === 1;
  } catch (error) {
    console.error('Database health check failed:', error);
    return false;
  }
}

// Graceful shutdown
export async function closePool(): Promise<void> {
  await pool.end();
  console.log('Database pool closed');
}

// Development pool pressure monitoring
if (process.env.NODE_ENV === 'development') {
  setInterval(() => {
    const metrics = getPoolMetrics();
    if (metrics.waitingCount > 0) {
      console.warn('Pool pressure:', metrics);
    }
  }, 30000);
}
