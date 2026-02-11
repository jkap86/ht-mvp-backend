/**
 * Derby Timer Job
 *
 * Processes expired derby slot pick deadlines.
 * Runs every 2 seconds and applies the configured timeout policy.
 */

import { Pool } from 'pg';
import { container, KEYS } from '../container';
import { DerbyService } from '../modules/drafts/derby/derby.service';
import { DerbyRepository } from '../modules/drafts/derby/derby.repository';
import { logger } from '../config/logger.config';
import { getLockId, LockDomain } from '../shared/locks';

let intervalId: NodeJS.Timeout | null = null;

// Check for expired derby picks every 2 seconds
const DERBY_INTERVAL_MS = 2000;

// Job lock ID in unified namespace (LockDomain.JOB = 900_000_000+)
// ID 6 is used by update-trending.job.ts — do not reuse
const DERBY_LOCK_ID = getLockId(LockDomain.JOB, 9);

/**
 * Process derby timeouts with distributed lock protection.
 * Uses pg_try_advisory_lock to ensure only one instance processes at a time.
 */
async function processDerbyTimeouts(): Promise<void> {
  const pool = container.resolve<Pool>(KEYS.POOL);
  const client = await pool.connect();
  const tickStart = Date.now();
  let derbiesProcessed = 0;
  let timeoutsHandled = 0;

  try {
    // Try to acquire advisory lock (non-blocking)
    const lockResult = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) as acquired',
      [DERBY_LOCK_ID]
    );

    if (!lockResult.rows[0].acquired) {
      // Another instance has the lock, skip this tick
      logger.debug('derby lock not acquired, skipping', { jobName: 'derby' });
      return;
    }

    logger.debug('derby tick started', { jobName: 'derby' });

    try {
      const derbyRepo = container.resolve<DerbyRepository>(KEYS.DERBY_REPO);
      const derbyService = container.resolve<DerbyService>(KEYS.DERBY_SERVICE);

      // Find all derby drafts with expired deadlines
      const expiredDerbies = await derbyRepo.findExpiredDerbyDrafts();

      for (const draft of expiredDerbies) {
        derbiesProcessed++;
        try {
          await derbyService.processTimeout(draft.id);
          timeoutsHandled++;
          logger.info(`Derby ${draft.id}: processed timeout`);
        } catch (error) {
          // Log but don't throw - continue processing other derbies
          logger.error('derby timeout error', { jobName: 'derby', draftId: draft.id, error });
        }
      }

      const durationMs = Date.now() - tickStart;
      if (derbiesProcessed > 0) {
        logger.info('derby tick complete', {
          jobName: 'derby',
          derbiesProcessed,
          timeoutsHandled,
          durationMs,
        });
      }
    } finally {
      // Always release advisory lock
      await client.query('SELECT pg_advisory_unlock($1)', [DERBY_LOCK_ID]);
    }
  } finally {
    client.release();
  }
}

/**
 * Start the derby job scheduler.
 */
export function startDerbyJob(): void {
  if (intervalId) {
    logger.warn('Derby job already running');
    return;
  }

  logger.info(`Starting derby job (interval: ${DERBY_INTERVAL_MS}ms)`);

  intervalId = setInterval(async () => {
    try {
      await processDerbyTimeouts();
    } catch (error) {
      logger.error('derby job error', { jobName: 'derby', error });
    }
  }, DERBY_INTERVAL_MS);
}

/**
 * Stop the derby job scheduler.
 */
export function stopDerbyJob(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('Derby job stopped');
  }
}
