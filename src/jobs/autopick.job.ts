import { Pool } from 'pg';
import { container, KEYS } from '../container';
import { DraftEngineFactory } from '../engines';
import { DraftRepository } from '../modules/drafts/drafts.repository';
import { logger } from '../config/env.config';

let intervalId: NodeJS.Timeout | null = null;

// Check for expired picks every 5 seconds
const AUTOPICK_INTERVAL_MS = 5000;

// Fixed advisory lock ID for autopick job (prevents multiple instances processing same drafts)
const AUTOPICK_LOCK_ID = 999999;

/**
 * Process autopicks with distributed lock protection.
 * Uses pg_try_advisory_lock to ensure only one instance processes at a time.
 */
async function processAutopicks(): Promise<void> {
  const pool = container.resolve<Pool>(KEYS.POOL);
  const client = await pool.connect();

  try {
    // Try to acquire advisory lock (non-blocking)
    const lockResult = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) as acquired',
      [AUTOPICK_LOCK_ID]
    );

    if (!lockResult.rows[0].acquired) {
      // Another instance has the lock, skip this tick
      return;
    }

    try {
      const draftRepo = container.resolve<DraftRepository>(KEYS.DRAFT_REPO);
      const engineFactory = container.resolve<DraftEngineFactory>(KEYS.DRAFT_ENGINE_FACTORY);

      // Find all drafts with expired deadlines
      const expiredDrafts = await draftRepo.findExpiredDrafts();

      for (const draft of expiredDrafts) {
        try {
          // Get the appropriate engine for this draft type
          const engine = engineFactory.createEngine(draft.draftType);
          const result = await engine.tick(draft.id);

          if (result.actionTaken) {
            logger.info(`Draft ${draft.id}: autopick via engine.tick() (${result.reason})`);
          }
        } catch (error) {
          logger.error(`Failed to process draft ${draft.id}: ${error}`);
        }
      }
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
      logger.error(`Autopick job error: ${error}`);
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
