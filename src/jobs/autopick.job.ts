import { container, KEYS } from '../container';
import { DraftEngineFactory } from '../engines';
import { DraftRepository } from '../modules/drafts/drafts.repository';
import { logger } from '../config/env.config';

let intervalId: NodeJS.Timeout | null = null;

// Check for expired picks every 5 seconds
const AUTOPICK_INTERVAL_MS = 5000;

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
