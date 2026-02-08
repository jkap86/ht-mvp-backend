import { Pool } from 'pg';
import { container, KEYS } from '../container';
import { WaiversService } from '../modules/waivers/waivers.service';
import { parseWaiverSettings } from '../modules/waivers/waivers.model';
import { tryGetEventBus, EventTypes } from '../shared/events';
import { getLockId, LockDomain } from '../shared/locks';
import { logger } from '../config/logger.config';

let intervalId: NodeJS.Timeout | null = null;

// Run every minute to check if any leagues need waiver processing
const CHECK_INTERVAL_MS = 60000; // 1 minute
// Job lock ID in unified namespace (LockDomain.JOB = 900_000_000+)
const WAIVER_PROCESSING_LOCK_ID = getLockId(LockDomain.JOB, 2);

/**
 * Check if the current time matches the waiver processing time for the given settings
 */
function shouldProcessWaivers(waiverDay: number, waiverHour: number): boolean {
  const now = new Date();
  const currentDay = now.getUTCDay(); // 0 = Sunday, 1 = Monday, etc.
  const currentHour = now.getUTCHours();

  return currentDay === waiverDay && currentHour === waiverHour;
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

      // Get all active leagues with waiver settings
      const leaguesResult = await client.query<{
        id: number;
        settings: any;
        status: string;
      }>(`
        SELECT id, settings, status
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

          // Check if current time matches waiver processing time
          if (!shouldProcessWaivers(waiverSettings.waiverDay, waiverSettings.waiverHour)) {
            continue;
          }

          // Check if we already processed waivers for this league in this hour
          // This prevents duplicate processing if the job runs multiple times per hour
          const lastProcessed = await client.query<{ count: string }>(
            `
            SELECT COUNT(*) as count FROM waiver_claims
            WHERE league_id = $1
            AND status IN ('successful', 'failed')
            AND processed_at >= date_trunc('hour', NOW())
          `,
            [league.id]
          );

          if (parseInt(lastProcessed.rows[0].count, 10) > 0) {
            logger.debug(`Waivers already processed for league ${league.id} this hour`, {
              jobName: 'waiver-processing',
            });
            continue;
          }

          // Process claims for this league
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
