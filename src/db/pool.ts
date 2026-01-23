import { Pool } from 'pg';
import { getDatabaseConfig } from '../config/database.config';

// Create database connection pool
export const pool = new Pool(getDatabaseConfig());

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
