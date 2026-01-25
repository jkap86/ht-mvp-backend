import { container, KEYS } from '../container';
import { StatsService } from '../modules/scoring/stats.service';
import { logger } from '../config/env.config';

let intervalId: NodeJS.Timeout | null = null;
let isRunning = false;

// 1 hour in milliseconds - check for stats updates hourly
const SYNC_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Run the weekly stats sync from Sleeper API
 * Protected against concurrent runs
 */
export async function runStatsSync(): Promise<void> {
  if (isRunning) {
    logger.warn('Stats sync already in progress, skipping');
    return;
  }

  isRunning = true;
  try {
    logger.info('Starting stats sync from Sleeper API...');
    const statsService = container.resolve<StatsService>(KEYS.STATS_SERVICE);

    // Get current NFL week
    const { season, week } = await statsService.getCurrentNflWeek();
    logger.info(`Current NFL week: ${season} week ${week}`);

    // Sync stats for the current week
    const result = await statsService.syncWeeklyStats(parseInt(season, 10), week);
    logger.info(`Stats sync complete: ${result.synced} synced, ${result.skipped} skipped, ${result.total} total`);
  } catch (error) {
    logger.error(`Stats sync error: ${error}`);
  } finally {
    isRunning = false;
  }
}

/**
 * Sync stats for a specific week (manual trigger)
 */
export async function syncWeekStats(season: number, week: number): Promise<{ synced: number; skipped: number; total: number }> {
  logger.info(`Manual stats sync for ${season} week ${week}...`);
  const statsService = container.resolve<StatsService>(KEYS.STATS_SERVICE);
  return statsService.syncWeeklyStats(season, week);
}

/**
 * Sync projections for a specific week (manual trigger)
 */
export async function syncWeekProjections(season: number, week: number): Promise<{ synced: number; skipped: number; total: number }> {
  logger.info(`Manual projections sync for ${season} week ${week}...`);
  const statsService = container.resolve<StatsService>(KEYS.STATS_SERVICE);
  return statsService.syncWeeklyProjections(season, week);
}

/**
 * Start the stats sync job scheduler
 * @param runImmediately - If true, runs sync immediately on startup
 */
export function startStatsSyncJob(runImmediately = false): void {
  if (intervalId) {
    logger.warn('Stats sync job already running');
    return;
  }

  const intervalMinutes = SYNC_INTERVAL_MS / 1000 / 60;
  logger.info(`Starting stats sync job (interval: ${intervalMinutes}min)`);

  // Run immediately on startup if requested
  if (runImmediately) {
    runStatsSync();
  }

  intervalId = setInterval(runStatsSync, SYNC_INTERVAL_MS);
}

/**
 * Stop the stats sync job scheduler
 */
export function stopStatsSyncJob(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('Stats sync job stopped');
  }
}
