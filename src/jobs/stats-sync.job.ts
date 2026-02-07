import { container, KEYS } from '../container';
import { StatsService } from '../modules/scoring/stats.service';
import { ScoringService } from '../modules/scoring/scoring.service';
import { MatchupsRepository } from '../modules/matchups/matchups.repository';
import { LineupService } from '../modules/lineups/lineups.service';
import { LeagueRepository } from '../modules/leagues/leagues.repository';
import { BestballService } from '../modules/bestball/bestball.service';
import { LeaderLock } from '../shared/leader-lock';
import { tryGetSocketService } from '../socket/socket.service';
import { logger } from '../config/env.config';
import { isInGameWindow, getOptimalSyncInterval, SYNC_INTERVALS } from '../utils/game-window';

let timeoutId: NodeJS.Timeout | null = null;
let isRunning = false;

// Thursday 8:20 PM ET (20:20 in 24h format)
const THURSDAY_LOCK_HOUR = 20;
const THURSDAY_LOCK_MINUTE = 20;

/**
 * Check if current time is past Thursday 8:20 PM ET for the current week
 * Thursday is day 4 in JavaScript (0 = Sunday, 4 = Thursday)
 */
function isPastThursdayLockTime(): boolean {
  // Get current time in ET (Eastern Time)
  const now = new Date();
  const etOptions = { timeZone: 'America/New_York' };
  const etString = now.toLocaleString('en-US', etOptions);
  const etDate = new Date(etString);

  const dayOfWeek = etDate.getDay(); // 0 = Sunday, 4 = Thursday
  const hours = etDate.getHours();
  const minutes = etDate.getMinutes();

  // If it's Thursday, check if past 8:20 PM
  if (dayOfWeek === 4) {
    return (
      hours > THURSDAY_LOCK_HOUR ||
      (hours === THURSDAY_LOCK_HOUR && minutes >= THURSDAY_LOCK_MINUTE)
    );
  }

  // If it's Friday (5), Saturday (6), Sunday (0), Monday (1), Tuesday (2), or Wednesday (3) after Thursday
  // Friday through Wednesday before Thursday = past lock time for current NFL week
  // We consider Friday, Saturday, and Sunday as past Thursday
  // Monday, Tuesday, Wednesday are before the next Thursday
  return dayOfWeek === 5 || dayOfWeek === 6 || dayOfWeek === 0;
}

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

    const socketService = tryGetSocketService();
    for (const leagueId of leagueIds) {
      socketService?.emitScoresUpdated(leagueId, { week, matchups: [] });
    }
    logger.info(`Notified ${leagueIds.length} leagues of score updates for week ${week}`);
  } catch (error) {
    // Don't fail the sync if socket notification fails
    logger.warn(`Failed to notify leagues of score update: ${error}`);
  }
}

/**
 * Lock lineups for all leagues with thursday_2020 lock time setting
 * This runs as part of the stats sync job
 */
async function checkAndLockLineups(season: number, week: number): Promise<void> {
  if (!isPastThursdayLockTime()) {
    logger.info('Not past Thursday 8:20 PM ET, skipping lineup lock check');
    return;
  }

  try {
    const lineupService = container.resolve<LineupService>(KEYS.LINEUP_SERVICE);
    const lockedCount = await lineupService.lockWeekLineupsByLockTime(
      season,
      week,
      'thursday_2020'
    );

    if (lockedCount > 0) {
      logger.info(`Locked ${lockedCount} lineups for ${season} week ${week} (thursday_2020)`);
    } else {
      logger.info(`No unlocked lineups to lock for ${season} week ${week}`);
    }
  } catch (error) {
    // Don't fail the sync if lineup locking fails
    logger.warn(`Failed to lock lineups: ${error}`);
  }
}

/**
 * Generate bestball lineups for all bestball leagues before scoring
 */
async function generateBestballLineups(
  bestballService: BestballService,
  leagueRepo: LeagueRepository,
  leagueIds: number[],
  season: number,
  week: number
): Promise<void> {
  let bestballCount = 0;

  for (const leagueId of leagueIds) {
    try {
      const league = await leagueRepo.findById(leagueId);
      if (league?.leagueSettings?.rosterType === 'bestball') {
        await bestballService.generateBestballLineupsForLeague(
          leagueId,
          season,
          week,
          'live_projected'
        );
        bestballCount++;
      }
    } catch (error) {
      logger.warn(`Failed to generate bestball lineups for league ${leagueId}: ${error}`);
    }
  }

  if (bestballCount > 0) {
    logger.info(`Generated bestball lineups for ${bestballCount} leagues`);
  }
}

/**
 * Calculate live scoring totals for all leagues with active matchups
 */
async function calculateLiveScoringTotals(
  scoringService: ScoringService,
  leagueIds: number[],
  season: number,
  week: number
): Promise<void> {
  if (leagueIds.length === 0) return;

  const inGameWindow = isInGameWindow();
  logger.info(
    `Calculating live scoring for ${leagueIds.length} leagues (game window: ${inGameWindow})`
  );

  for (const leagueId of leagueIds) {
    try {
      // Always calculate actual totals
      await scoringService.calculateWeeklyLiveActualTotalsForLeague(leagueId, season, week);

      // Calculate projected totals (uses game progress for mid-game projections)
      await scoringService.calculateWeeklyLiveProjectedTotalsForLeague(leagueId, season, week);
    } catch (error) {
      // Don't fail the entire sync if one league fails
      logger.warn(`Failed to calculate live totals for league ${leagueId}: ${error}`);
    }
  }
}

/**
 * Run the weekly stats sync from Sleeper API
 * Protected against concurrent runs and uses leader lock for multi-instance safety
 */
export async function runStatsSync(): Promise<void> {
  if (isRunning) {
    logger.warn('Stats sync already in progress, skipping');
    return;
  }

  // Use leader lock to ensure only one instance runs the job
  const leaderLock = container.resolve<LeaderLock>(KEYS.LEADER_LOCK);
  const result = await leaderLock.runAsLeader(async () => {
    return executeStatsSync();
  });

  if (result === null) {
    logger.debug('Not leader, skipping stats sync');
  }
}

/**
 * Execute the actual stats sync logic (called by leader instance only)
 */
async function executeStatsSync(): Promise<void> {
  isRunning = true;
  try {
    const inGameWindow = isInGameWindow();
    logger.info(`Starting stats sync from Sleeper API (game window: ${inGameWindow})...`);

    const statsService = container.resolve<StatsService>(KEYS.STATS_SERVICE);
    const scoringService = container.resolve<ScoringService>(KEYS.SCORING_SERVICE);
    const matchupsRepo = container.resolve<MatchupsRepository>(KEYS.MATCHUPS_REPO);

    // Get current NFL week
    const { season, week } = await statsService.getCurrentNflWeek();
    const seasonNum = parseInt(season, 10);
    logger.info(`Current NFL week: ${season} week ${week}`);

    // Sync actual stats for the current week
    const statsResult = await statsService.syncWeeklyStats(seasonNum, week);
    logger.info(
      `Stats sync complete: ${statsResult.synced} synced, ${statsResult.skipped} skipped`
    );

    // Sync projections (writes to separate player_projections table)
    const projResult = await statsService.syncWeeklyProjections(seasonNum, week);
    logger.info(
      `Projections sync complete: ${projResult.synced} synced, ${projResult.skipped} skipped`
    );

    // Get leagues with active matchups
    const leagueIds = await matchupsRepo.getLeaguesWithActiveMatchups(seasonNum, week);

    // Generate bestball lineups before calculating totals
    if (leagueIds.length > 0) {
      const bestballService = container.resolve<BestballService>(KEYS.BESTBALL_SERVICE);
      const leagueRepo = container.resolve<LeagueRepository>(KEYS.LEAGUE_REPO);
      await generateBestballLineups(bestballService, leagueRepo, leagueIds, seasonNum, week);
    }

    // Calculate live scoring totals for all leagues
    if (leagueIds.length > 0) {
      await calculateLiveScoringTotals(scoringService, leagueIds, seasonNum, week);
    }

    // Notify leagues with active matchups for this week
    if (statsResult.synced > 0 || projResult.synced > 0) {
      await notifyLeaguesOfScoreUpdate(matchupsRepo, seasonNum, week);
    }

    // Check and lock lineups if past Thursday 8:20 PM ET
    await checkAndLockLineups(seasonNum, week);
  } catch (error) {
    logger.error(`Stats sync error: ${error}`);
  } finally {
    isRunning = false;
  }
}

/**
 * Sync stats for a specific week (manual trigger)
 */
export async function syncWeekStats(
  season: number,
  week: number
): Promise<{ synced: number; skipped: number; total: number }> {
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
export async function syncWeekProjections(
  season: number,
  week: number
): Promise<{ synced: number; skipped: number; total: number }> {
  logger.info(`Manual projections sync for ${season} week ${week}...`);
  const statsService = container.resolve<StatsService>(KEYS.STATS_SERVICE);
  return statsService.syncWeeklyProjections(season, week);
}

/**
 * Schedule the next sync with dynamic interval based on game window
 */
function scheduleNextSync(): void {
  const interval = getOptimalSyncInterval();
  const intervalMinutes = interval / 1000 / 60;
  const inGameWindow = isInGameWindow();

  logger.info(
    `Scheduling next stats sync in ${intervalMinutes} minutes (game window: ${inGameWindow})`
  );

  timeoutId = setTimeout(async () => {
    await runStatsSync();
    // Schedule the next sync after this one completes
    if (timeoutId !== null) {
      scheduleNextSync();
    }
  }, interval);
}

/**
 * Start the stats sync job scheduler with dynamic intervals
 * - 2 minutes during game windows
 * - 60 minutes when no games are in progress
 * @param runImmediately - If true, runs sync immediately on startup
 */
export function startStatsSyncJob(runImmediately = false): void {
  if (timeoutId) {
    logger.warn('Stats sync job already running');
    return;
  }

  logger.info(
    `Starting stats sync job with dynamic intervals (${SYNC_INTERVALS.LIVE / 1000 / 60}min live, ${SYNC_INTERVALS.OFF / 1000 / 60}min off)`
  );

  // Run immediately on startup if requested
  if (runImmediately) {
    runStatsSync().then(() => {
      scheduleNextSync();
    });
  } else {
    scheduleNextSync();
  }
}

/**
 * Stop the stats sync job scheduler
 */
export function stopStatsSyncJob(): void {
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
    logger.info('Stats sync job stopped');
  }
}
