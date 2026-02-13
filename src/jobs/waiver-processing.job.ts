import { Pool } from 'pg';
import { container, KEYS } from '../container';
import { WaiversService } from '../modules/waivers/waivers.service';
import { parseWaiverSettings } from '../modules/waivers/waivers.model';
import { tryGetEventBus, EventTypes } from '../shared/events';
import { getLockId, LockDomain } from '../shared/locks';
import { logger } from '../config/logger.config';
import { isCurrentTimeMatch, utcWeekdayToLuxonWeekday } from '../shared/utils/timezone.utils';

/**
 * LOCK CONTRACT:
 * - processWaivers() acquires JOB lock (900M + 2) via pg_try_advisory_lock — singleton job execution
 *   Then delegates to WaiversService.processLeagueClaims() which acquires WAIVER lock (400M + leagueId)
 *   JOB lock is session-level (not transactional); released explicitly after processing
 *
 * Lock ordering: JOB lock is session-level, WAIVER lock is transactional (inside processLeagueClaims).
 * No deadlock risk because session-level locks don't participate in transactional lock ordering.
 */

let intervalId: NodeJS.Timeout | null = null;

// Run every minute to check if any leagues need waiver processing
const CHECK_INTERVAL_MS = 60000; // 1 minute
// Job lock ID in unified namespace (LockDomain.JOB = 900_000_000+)
const WAIVER_PROCESSING_LOCK_ID = getLockId(LockDomain.JOB, 2);

/**
 * Check if the current time matches the waiver processing time for the given settings.
 *
 * @param waiverDay - UTC weekday (0-6, Sunday-Saturday) - LEGACY: for backward compatibility
 * @param waiverHour - Hour in league's timezone (0-23)
 * @param timezone - IANA timezone name (e.g., 'America/New_York')
 * @returns True if current time matches waiver processing time in the league's timezone
 */
function shouldProcessWaivers(
  waiverDay: number,
  waiverHour: number,
  timezone: string = 'America/New_York'
): boolean {
  // Convert UTC weekday to Luxon weekday for timezone-aware comparison
  const luxonWeekday = utcWeekdayToLuxonWeekday(waiverDay);

  // Check if current time in league's timezone matches target weekday/hour
  // Use 60-minute tolerance to ensure we don't miss processing window
  return isCurrentTimeMatch(luxonWeekday, waiverHour, timezone, 60);
}

/**
 * Process waivers for all eligible leagues
 */
async function processWaivers(): Promise<void> {
  const pool = container.resolve<Pool>(KEYS.POOL);
  const client = await pool.connect();
  const tickStart = Date.now();
  let leaguesProcessed = 0;
  let totalClaims = 0;
  let successfulClaims = 0;

  try {
    // Try to acquire advisory lock (non-blocking)
    const lockResult = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) as acquired',
      [WAIVER_PROCESSING_LOCK_ID]
    );

    if (!lockResult.rows[0].acquired) {
      // Another instance has the lock, skip this tick
      logger.debug('waiver-processing lock not acquired, skipping', {
        jobName: 'waiver-processing',
      });
      return;
    }

    logger.debug('waiver-processing tick started', { jobName: 'waiver-processing' });

    try {
      const waiversService = container.resolve<WaiversService>(KEYS.WAIVERS_SERVICE);

      // Get all active leagues with waiver settings and timezone
      const leaguesResult = await client.query<{
        id: number;
        settings: any;
        status: string;
        season: string;
        current_week: number | null;
        timezone: string;
      }>(`
        SELECT id, settings, status, season, current_week, timezone
        FROM leagues
        WHERE status IN ('active', 'in_progress')
        AND settings->>'waiver_type' IS NOT NULL
        AND settings->>'waiver_type' != 'none'
      `);

      for (const league of leaguesResult.rows) {
        try {
          const waiverSettings = parseWaiverSettings(league.settings);

          // Skip if waiver type is 'none'
          if (waiverSettings.waiverType === 'none') {
            continue;
          }

          // Check if current time matches waiver processing time in league's timezone
          const leagueTimezone = league.timezone || 'America/New_York';
          if (!shouldProcessWaivers(waiverSettings.waiverDay, waiverSettings.waiverHour, leagueTimezone)) {
            continue;
          }

          // Skip if no current week set (pre-season)
          const currentWeek = league.settings?.current_week ?? league.current_week ?? null;
          if (currentWeek === null) {
            logger.debug(`League ${league.id} has no current week, skipping waiver processing`, {
              jobName: 'waiver-processing',
            });
            continue;
          }

          // Process claims for this league.
          // Deduplication is handled atomically inside processLeagueClaims:
          // the processing run record is created within the same transaction
          // that processes claims, preventing double-processing on crash/restart.
          logger.info(`Processing waivers for league ${league.id}`, {
            jobName: 'waiver-processing',
          });
          const result = await waiversService.processLeagueClaims(league.id);

          leaguesProcessed++;
          totalClaims += result.processed;
          successfulClaims += result.successful;

          logger.info(
            `Waivers processed for league ${league.id}: ${result.successful}/${result.processed} successful`,
            { jobName: 'waiver-processing', leagueId: league.id }
          );

          // Emit domain event for waiver processing completion
          const eventBus = tryGetEventBus();
          eventBus?.publish({
            type: EventTypes.WAIVER_PROCESSED,
            leagueId: league.id,
            payload: {
              processed: result.processed,
              successful: result.successful,
            },
          });
        } catch (leagueError) {
          logger.error(`Failed to process waivers for league ${league.id}`, {
            jobName: 'waiver-processing',
            leagueId: league.id,
            error: leagueError,
          });
        }
      }

      const durationMs = Date.now() - tickStart;
      logger.info('waiver-processing tick complete', {
        jobName: 'waiver-processing',
        leaguesProcessed,
        totalClaims,
        successfulClaims,
        durationMs,
      });
    } finally {
      // Always release advisory lock
      await client.query('SELECT pg_advisory_unlock($1)', [WAIVER_PROCESSING_LOCK_ID]);
    }
  } catch (error) {
    logger.error('waiver-processing job error', { jobName: 'waiver-processing', error });
  } finally {
    client.release();
  }
}

/**
 * Clean up expired waiver wire entries (players whose waiver period has ended)
 */
async function cleanupExpiredWaiverWire(): Promise<void> {
  const pool = container.resolve<Pool>(KEYS.POOL);
  const client = await pool.connect();

  try {
    const result = await client.query(`
      DELETE FROM waiver_wire
      WHERE waiver_expires_at < NOW()
      RETURNING id, league_id, player_id
    `);

    if (result.rowCount && result.rowCount > 0) {
      logger.info(`Cleaned up ${result.rowCount} expired waiver wire entries`, {
        jobName: 'waiver-processing',
      });
    }
  } catch (error) {
    logger.error('Failed to cleanup expired waiver wire entries', {
      jobName: 'waiver-processing',
      error,
    });
  } finally {
    client.release();
  }
}

export function startWaiverProcessingJob(): void {
  if (intervalId) {
    logger.warn('Waiver processing job already running');
    return;
  }

  logger.info(`Starting waiver processing job (interval: ${CHECK_INTERVAL_MS}ms)`);

  intervalId = setInterval(async () => {
    try {
      await processWaivers();
      await cleanupExpiredWaiverWire();
    } catch (error) {
      logger.error('waiver-processing job error', { jobName: 'waiver-processing', error });
    }
  }, CHECK_INTERVAL_MS);
}

export function stopWaiverProcessingJob(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('Waiver processing job stopped');
  }
}
