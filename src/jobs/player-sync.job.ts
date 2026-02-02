import { container, KEYS } from '../container';
import { PlayerService } from '../modules/players/players.service';
import { logger } from '../config/env.config';

let intervalId: NodeJS.Timeout | null = null;
let isRunning = false;
let isCollegeSyncRunning = false;

// 12 hours in milliseconds
const SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000;

/**
 * Run the player sync from Sleeper API
 * Protected against concurrent runs
 */
export async function runPlayerSync(): Promise<void> {
  if (isRunning) {
    logger.warn('Player sync already in progress, skipping');
    return;
  }

  isRunning = true;
  try {
    logger.info('Starting player sync from Sleeper API...');
    const playerService = container.resolve<PlayerService>(KEYS.PLAYER_SERVICE);
    const result = await playerService.syncPlayersFromSleeper();
    logger.info(`Player sync complete: ${result.synced} synced, ${result.total} total`);
  } catch (error) {
    logger.error(`Player sync error: ${error}`);
  } finally {
    isRunning = false;
  }
}

/**
 * Run the college player sync from CFBD API
 * Protected against concurrent runs
 */
export async function runCollegePlayerSync(): Promise<void> {
  if (isCollegeSyncRunning) {
    logger.warn('College player sync already in progress, skipping');
    return;
  }

  isCollegeSyncRunning = true;
  try {
    logger.info('Starting college player sync from CFBD API...');
    const playerService = container.resolve<PlayerService>(KEYS.PLAYER_SERVICE);
    const result = await playerService.syncCollegePlayersFromCFBD();
    logger.info(`College player sync complete: ${result.synced} synced, ${result.total} total`);
  } catch (error) {
    // Don't fail startup if CFBD sync fails (API key may not be configured)
    logger.warn(`College player sync skipped or failed: ${error}`);
  } finally {
    isCollegeSyncRunning = false;
  }
}

/**
 * Start the player sync job scheduler
 * @param runImmediately - If true, runs sync immediately on startup
 */
export function startPlayerSyncJob(runImmediately = true): void {
  if (intervalId) {
    logger.warn('Player sync job already running');
    return;
  }

  const intervalHours = SYNC_INTERVAL_MS / 1000 / 60 / 60;
  logger.info(`Starting player sync job (interval: ${intervalHours}h)`);

  // Run immediately on startup if requested
  if (runImmediately) {
    runPlayerSync();
    // College sync runs incrementally - only fetches teams not already in DB
    runCollegePlayerSync();
  }

  intervalId = setInterval(runPlayerSync, SYNC_INTERVAL_MS);
}

/**
 * Stop the player sync job scheduler
 */
export function stopPlayerSyncJob(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('Player sync job stopped');
  }
}
