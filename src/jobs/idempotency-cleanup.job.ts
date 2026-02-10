import { Pool } from 'pg';
import { container, KEYS } from '../container';
import { logger } from '../config/logger.config';

let intervalId: NodeJS.Timeout | null = null;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

async function cleanupExpiredKeys(): Promise<void> {
  const pool = container.resolve<Pool>(KEYS.POOL);
  try {
    const result = await pool.query(
      'DELETE FROM idempotency_keys WHERE expires_at < NOW()'
    );
    if (result.rowCount && result.rowCount > 0) {
      logger.info('Cleaned up expired idempotency keys', { count: result.rowCount });
    }
  } catch (err) {
    logger.error('Idempotency cleanup failed', { error: (err as Error).message });
  }
}

export function startIdempotencyCleanupJob(): void {
  logger.info('Starting idempotency cleanup job (interval: 1h)');
  intervalId = setInterval(cleanupExpiredKeys, CLEANUP_INTERVAL_MS);
}

export function stopIdempotencyCleanupJob(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
