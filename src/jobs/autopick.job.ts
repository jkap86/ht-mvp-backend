import { Pool } from 'pg';
import { container, KEYS } from '../container';
import { DraftEngineFactory } from '../engines';
import { DraftRepository } from '../modules/drafts/drafts.repository';
import { logger } from '../config/logger.config';
import { ValidationException } from '../utils/exceptions';
import { getLockId, LockDomain } from '../shared/locks';
import { isInPauseWindow } from '../shared/utils/time-utils';
import { EventTypes, tryGetEventBus } from '../shared/events';

/**
 * LOCK CONTRACT:
 * - processAutopicks() acquires JOB lock (900M + 1) via pg_try_advisory_lock — singleton job execution
 *   Then delegates to engine.tick() which acquires DRAFT lock (700M + draftId) per draft
 *   JOB lock is session-level (not transactional); released explicitly after processing
 *
 * Lock ordering: JOB (priority 9) is the outermost lock, then DRAFT (priority 7) inside.
 * Although JOB > DRAFT in priority number, there is no deadlock risk because the JOB lock
 * is session-level (pg_try_advisory_lock) while DRAFT is transactional (pg_advisory_xact_lock).
 */

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

      // Find all drafts with expired deadlines OR in-progress drafts with overnight pause enabled
      // (to check for pause window transitions)
      const expiredDrafts = await draftRepo.findExpiredDrafts();

      // Also get in-progress drafts with overnight pause enabled to check for pause window transitions
      const pauseEnabledDrafts = await draftRepo.findByStatusAndOvernightPauseEnabled('in_progress');

      // Combine and deduplicate by ID
      const allDrafts = [...expiredDrafts, ...pauseEnabledDrafts];
      const uniqueDrafts = Array.from(new Map(allDrafts.map(d => [d.id, d])).values());

      for (const draft of uniqueDrafts) {
        // Auction drafts use slow-auction.job.ts for settlement, not autopick
        if (draft.draftType === 'auction') {
          continue;
        }

        draftsProcessed++;

        // Check for overnight pause window transitions (only for snake/linear drafts)
        if (
          draft.status === 'in_progress' &&
          draft.overnightPauseEnabled &&
          draft.overnightPauseStart &&
          draft.overnightPauseEnd
        ) {
          const isCurrentlyInPause = isInPauseWindow(
            new Date(),
            draft.overnightPauseStart,
            draft.overnightPauseEnd
          );
          const wasInPause = draft.draftState?.inOvernightPause ?? false;

          // State transition: entered pause window
          if (isCurrentlyInPause && !wasInPause) {
            logger.info(`Draft ${draft.id}: entering overnight pause window`);

            // Bare draftRepo.update() + eventBus.publish() is safe here because:
            // 1. This is informational-only state (inOvernightPause flag) — no roster/pick mutations
            // 2. eventBus is synchronous in-memory dispatch, not cross-process
            // 3. If a race causes a missed transition, the next tick (2s) provides eventual consistency
            await draftRepo.update(draft.id, {
              draftState: { ...draft.draftState, inOvernightPause: true },
            });

            // Emit socket event
            const eventBus = tryGetEventBus();
            eventBus?.publish({
              type: EventTypes.DRAFT_OVERNIGHT_PAUSE_STARTED,
              payload: {
                draftId: draft.id,
                leagueId: draft.leagueId,
                pauseStart: draft.overnightPauseStart,
                pauseEnd: draft.overnightPauseEnd,
              },
            });
          }
          // State transition: exited pause window
          else if (!isCurrentlyInPause && wasInPause) {
            logger.info(`Draft ${draft.id}: exiting overnight pause window`);

            // Update draft state to track pause status
            await draftRepo.update(draft.id, {
              draftState: { ...draft.draftState, inOvernightPause: false },
            });

            // Emit socket event
            const eventBus = tryGetEventBus();
            eventBus?.publish({
              type: EventTypes.DRAFT_OVERNIGHT_PAUSE_ENDED,
              payload: {
                draftId: draft.id,
                leagueId: draft.leagueId,
                pauseStart: draft.overnightPauseStart,
                pauseEnd: draft.overnightPauseEnd,
              },
            });
          }
        }
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
