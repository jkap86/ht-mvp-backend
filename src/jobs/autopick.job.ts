import { container, KEYS } from '../container';
import { DraftAutopickService } from '../modules/drafts/draft-autopick.service';
import { logger } from '../config/env.config';

let intervalId: NodeJS.Timeout | null = null;

// Check for expired picks every 5 seconds
const AUTOPICK_INTERVAL_MS = 5000;

/**
 * Start the autopick job scheduler
 */
export function startAutopickJob(): void {
  if (intervalId) {
    logger.warn('Autopick job already running');
    return;
  }

  logger.info(`Starting autopick job (interval: ${AUTOPICK_INTERVAL_MS}ms)`);

  intervalId = setInterval(async () => {
    try {
      const autopickService = container.resolve<DraftAutopickService>(KEYS.DRAFT_AUTOPICK_SERVICE);
      await autopickService.processExpiredPicks();
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
