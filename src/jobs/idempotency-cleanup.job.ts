import { Pool } from 'pg';
import { container, KEYS } from '../container';
import { logger } from '../config/logger.config';
import { getLockId, LockDomain } from '../shared/locks';

let intervalId: NodeJS.Timeout | null = null;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Job lock ID in unified namespace (LockDomain.JOB = 900_000_000+)
// ID 12 is assigned to idempotency cleanup
const IDEMPOTENCY_CLEANUP_LOCK_ID = getLockId(LockDomain.JOB, 12);

async function cleanupExpiredKeys(): Promise<void> {
  const pool = container.resolve<Pool>(KEYS.POOL);
  const client = await pool.connect();

  try {
    // Try to acquire advisory lock (non-blocking)
    const lockResult = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) as acquired',
      [IDEMPOTENCY_CLEANUP_LOCK_ID]
    );

    if (!lockResult.rows[0].acquired) {
      logger.debug('Idempotency cleanup lock not acquired, skipping');
      return;
    }

    try {
      const result = await client.query('DELETE FROM idempotency_keys WHERE expires_at < NOW()');
      if (result.rowCount && result.rowCount > 0) {
        logger.info('Cleaned up expired idempotency keys', { count: result.rowCount });
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [IDEMPOTENCY_CLEANUP_LOCK_ID]);
    }
  } catch (err) {
    logger.error('Idempotency cleanup failed', { error: (err as Error).message });
  } finally {
    client.release();
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
