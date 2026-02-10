/**
 * Update Trending Players Job
 * Stream E: Waiver Wire Enhancements
 * Runs daily to update trending players and ownership data
 */

import { Pool } from 'pg';
import { container, KEYS } from '../container';
import { TrendingService } from '../modules/players/trending.service';
import { logger } from '../config/logger.config';
import { getLockId, LockDomain } from '../shared/locks';

let intervalId: NodeJS.Timeout | null = null;

// 24 hours in milliseconds (run daily)
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Job lock ID (in JOB domain namespace: 900_000_000+)
const TRENDING_UPDATE_JOB_ID = 6; // 900_000_006

/**
 * Run the trending players update
 * Updates ownership percentages, trending scores, and recent performance
 */
export async function runTrendingUpdate(): Promise<void> {
  const pool = container.resolve<Pool>(KEYS.POOL);
  const lockId = getLockId(LockDomain.JOB, TRENDING_UPDATE_JOB_ID);
  const client = await pool.connect();

  try {
    // Try to acquire advisory lock (non-blocking)
    const lockResult = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) as acquired',
      [lockId]
    );

    if (!lockResult.rows[0].acquired) {
      logger.debug('Trending update lock not acquired, skipping');
      return;
    }

    try {
      const tickStart = Date.now();
      logger.info('Starting trending players update...');

      const trendingService = new TrendingService(pool);
      const result = await trendingService.updateTrendingPlayers();

      logger.info(`Trending players update complete: ${result.updated} players updated`, {
        durationMs: Date.now() - tickStart,
      });
    } catch (error) {
      logger.error(`Trending players update error: ${error}`);
    } finally {
      // Release the advisory lock
      await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
    }
  } finally {
    client.release();
  }
}

/**
 * Start the trending update job
 * Runs immediately and then every 24 hours
 */
export function startTrendingUpdate() {
  if (intervalId) {
    logger.warn('Trending update already running');
    return;
  }

  logger.info(
    `Starting trending update job (every ${UPDATE_INTERVAL_MS / 1000 / 60 / 60} hours)`
  );

  // Run immediately
  runTrendingUpdate().catch((error) => {
    logger.error(`Initial trending update failed: ${error}`);
  });

  // Then run on interval
  intervalId = setInterval(() => {
    runTrendingUpdate().catch((error) => {
      logger.error(`Scheduled trending update failed: ${error}`);
    });
  }, UPDATE_INTERVAL_MS);
}

/**
 * Stop the trending update job
 */
export function stopTrendingUpdate() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('Trending update job stopped');
  }
}
