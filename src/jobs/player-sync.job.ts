import { Pool } from 'pg';
import { container, KEYS } from '../container';
import { PlayerService } from '../modules/players/players.service';
import { logger } from '../config/logger.config';
import { getLockId, LockDomain } from '../shared/locks';

let intervalId: NodeJS.Timeout | null = null;

// 12 hours in milliseconds
const SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000;

// Job lock IDs (in JOB domain namespace: 900_000_000+)
const PLAYER_SYNC_JOB_ID = 3; // 900_000_003
const COLLEGE_SYNC_JOB_ID = 4; // 900_000_004

/**
 * Run the player sync from Sleeper API
 * Protected against concurrent runs using PostgreSQL advisory lock
 */
export async function runPlayerSync(): Promise<void> {
  const pool = container.resolve<Pool>(KEYS.POOL);
  const lockId = getLockId(LockDomain.JOB, PLAYER_SYNC_JOB_ID);
  const client = await pool.connect();

  try {
    // Try to acquire advisory lock (non-blocking)
    const lockResult = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) as acquired',
      [lockId]
    );

    if (!lockResult.rows[0].acquired) {
      logger.debug('Player sync lock not acquired, skipping');
      return;
    }

    try {
      const tickStart = Date.now();
      logger.info('Starting player sync from configured provider...');
      const playerService = container.resolve<PlayerService>(KEYS.PLAYER_SERVICE);
      const result = await playerService.syncPlayersFromProvider();
      logger.info(`Player sync complete: ${result.synced} synced, ${result.total} total`, {
        durationMs: Date.now() - tickStart,
      });
    } catch (error) {
      logger.error(`Player sync error: ${error}`);
    } finally {
      // Release the advisory lock
      await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
    }
  } finally {
    client.release();
  }
}

/**
 * Run the college player sync from CFBD API
 * Protected against concurrent runs using PostgreSQL advisory lock
 */
export async function runCollegePlayerSync(): Promise<void> {
  const pool = container.resolve<Pool>(KEYS.POOL);
  const lockId = getLockId(LockDomain.JOB, COLLEGE_SYNC_JOB_ID);
  const client = await pool.connect();

  try {
    // Try to acquire advisory lock (non-blocking)
    const lockResult = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) as acquired',
      [lockId]
    );

    if (!lockResult.rows[0].acquired) {
      logger.debug('College player sync lock not acquired, skipping');
      return;
    }

    try {
      const tickStart = Date.now();
      logger.info('Starting college player sync from CFBD API...');
      const playerService = container.resolve<PlayerService>(KEYS.PLAYER_SERVICE);
      const result = await playerService.syncCollegePlayersFromCFBD();
      logger.info(`College player sync complete: ${result.synced} synced, ${result.total} total`, {
        durationMs: Date.now() - tickStart,
      });
    } catch (error) {
      // Don't fail startup if CFBD sync fails (API key may not be configured)
      logger.warn(`College player sync skipped or failed: ${error}`);
    } finally {
      // Release the advisory lock
      await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
    }
  } finally {
    client.release();
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

  // Schedule both NFL and college player syncs on the interval
  intervalId = setInterval(() => {
    runPlayerSync();
    runCollegePlayerSync();
  }, SYNC_INTERVAL_MS);
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
