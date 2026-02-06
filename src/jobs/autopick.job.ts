import { Pool } from 'pg';
import { container, KEYS } from '../container';
import { DraftEngineFactory } from '../engines';
import { DraftRepository } from '../modules/drafts/drafts.repository';
import { logger } from '../config/logger.config';
import { ValidationException } from '../utils/exceptions';
import { getLockId, LockDomain } from '../shared/locks';

let intervalId: NodeJS.Timeout | null = null;

// Check for expired picks every 2 seconds for better UX (reduced from 5s)
const AUTOPICK_INTERVAL_MS = 2000;

// Use LockDomain.JOB for consistent lock management
const AUTOPICK_LOCK_ID = getLockId(LockDomain.JOB, 1);

/**
 * Process autopicks with distributed lock protection.
 * Uses pg_try_advisory_lock to ensure only one instance processes at a time.
 */
async function processAutopicks(): Promise<void> {
  const pool = container.resolve<Pool>(KEYS.POOL);
  const client = await pool.connect();
  const tickStart = Date.now();
  let draftsProcessed = 0;
  let picksAutomated = 0;

  try {
    // Try to acquire advisory lock (non-blocking)
    const lockResult = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) as acquired',
      [AUTOPICK_LOCK_ID]
    );

    if (!lockResult.rows[0].acquired) {
      // Another instance has the lock, skip this tick
      logger.debug('autopick lock not acquired, skipping', { jobName: 'autopick' });
      return;
    }

    logger.debug('autopick tick started', { jobName: 'autopick' });

    try {
      const draftRepo = container.resolve<DraftRepository>(KEYS.DRAFT_REPO);
      const engineFactory = container.resolve<DraftEngineFactory>(KEYS.DRAFT_ENGINE_FACTORY);

      // Find all drafts with expired deadlines
      const expiredDrafts = await draftRepo.findExpiredDrafts();

      for (const draft of expiredDrafts) {
        // Auction drafts use slow-auction.job.ts for settlement, not autopick
        if (draft.draftType === 'auction') {
          continue;
        }

        draftsProcessed++;
        try {
          // Get the appropriate engine for this draft type
          const engine = engineFactory.createEngine(draft.draftType);
          const result = await engine.tick(draft.id);

          if (result.actionTaken) {
            picksAutomated++;
            logger.info(`Draft ${draft.id}: autopick via engine.tick() (${result.reason})`);
          }
        } catch (error) {
          // Gracefully handle race condition when manual pick beats autopick
          if (
            error instanceof ValidationException &&
            (error.message.includes('Draft state changed') ||
              error.message.includes('already been made') ||
              error.message.includes('not your turn'))
          ) {
            // This is expected and fine - user made manual pick first (preferred over autopick)
            logger.info('autopick skipped - manual pick was faster', {
              jobName: 'autopick',
              draftId: draft.id,
            });
          } else {
            // Unexpected error - log it
            logger.error('autopick draft error', { jobName: 'autopick', draftId: draft.id, error });
          }
        }
      }

      const durationMs = Date.now() - tickStart;
      logger.info('autopick tick complete', {
        jobName: 'autopick',
        draftsProcessed,
        picksAutomated,
        durationMs,
      });
    } finally {
      // Always release advisory lock
      await client.query('SELECT pg_advisory_unlock($1)', [AUTOPICK_LOCK_ID]);
    }
  } finally {
    client.release();
  }
}

/**
 * Start the autopick job scheduler.
 * Uses DraftEngine.tick() to process expired picks.
 */
export function startAutopickJob(): void {
  if (intervalId) {
    logger.warn('Autopick job already running');
    return;
  }

  logger.info(`Starting autopick job (interval: ${AUTOPICK_INTERVAL_MS}ms)`);

  intervalId = setInterval(async () => {
    try {
      await processAutopicks();
    } catch (error) {
      logger.error('autopick job error', { jobName: 'autopick', error });
    }
  }, AUTOPICK_INTERVAL_MS);
}

/**
 * Stop the autopick job scheduler
 */
export function stopAutopickJob(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('Autopick job stopped');
  }
}
