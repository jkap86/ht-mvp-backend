import { container, KEYS } from '../container';
import { StatsService } from '../modules/scoring/stats.service';
import { MatchupsRepository } from '../modules/matchups/matchups.repository';
import { getSocketService } from '../socket/socket.service';
import { logger } from '../config/env.config';

let intervalId: NodeJS.Timeout | null = null;
let isRunning = false;

// 1 hour in milliseconds - check for stats updates hourly
const SYNC_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Notify leagues with active matchups that scores have been updated
 */
async function notifyLeaguesOfScoreUpdate(
  matchupsRepo: MatchupsRepository,
  season: number,
  week: number
): Promise<void> {
  try {
    const leagueIds = await matchupsRepo.getLeaguesWithActiveMatchups(season, week);
    if (leagueIds.length === 0) {
      logger.info('No leagues with active matchups to notify');
      return;
    }

    const socketService = getSocketService();
    for (const leagueId of leagueIds) {
      socketService.emitScoresUpdated(leagueId, { week, matchups: [] });
    }
    logger.info(`Notified ${leagueIds.length} leagues of score updates for week ${week}`);
  } catch (error) {
    // Don't fail the sync if socket notification fails
    logger.warn(`Failed to notify leagues of score update: ${error}`);
  }
}

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
    const matchupsRepo = container.resolve<MatchupsRepository>(KEYS.MATCHUPS_REPO);

    // Get current NFL week
    const { season, week } = await statsService.getCurrentNflWeek();
    const seasonNum = parseInt(season, 10);
    logger.info(`Current NFL week: ${season} week ${week}`);

    // Sync stats for the current week
    const result = await statsService.syncWeeklyStats(seasonNum, week);
    logger.info(`Stats sync complete: ${result.synced} synced, ${result.skipped} skipped, ${result.total} total`);

    // Notify leagues with active matchups for this week
    if (result.synced > 0) {
      await notifyLeaguesOfScoreUpdate(matchupsRepo, seasonNum, week);
    }
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
  const matchupsRepo = container.resolve<MatchupsRepository>(KEYS.MATCHUPS_REPO);

  const result = await statsService.syncWeeklyStats(season, week);

  // Notify leagues if stats were synced
  if (result.synced > 0) {
    await notifyLeaguesOfScoreUpdate(matchupsRepo, season, week);
  }

  return result;
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
