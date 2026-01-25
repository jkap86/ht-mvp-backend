import { Pool } from 'pg';
import { container, KEYS } from '../container';
import { TradesService } from '../modules/trades/trades.service';
import { logger } from '../config/logger.config';

let intervalId: NodeJS.Timeout | null = null;

const TRADE_CHECK_INTERVAL_MS = 60000; // 60 seconds (1 minute)
const TRADE_EXPIRATION_LOCK_ID = 999997;

/**
 * Process expired trades and completed review periods
 */
async function processTradeExpirations(): Promise<void> {
  const pool = container.resolve<Pool>(KEYS.POOL);
  const client = await pool.connect();
  const tickStart = Date.now();

  try {
    // Try to acquire advisory lock (non-blocking)
    const lockResult = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) as acquired',
      [TRADE_EXPIRATION_LOCK_ID]
    );

    if (!lockResult.rows[0].acquired) {
      // Another instance has the lock, skip this tick
      logger.debug('trade-expiration lock not acquired, skipping', { jobName: 'trade-expiration' });
      return;
    }

    logger.debug('trade-expiration tick started', { jobName: 'trade-expiration' });

    try {
      const tradesService = container.resolve<TradesService>(KEYS.TRADES_SERVICE);

      // Process expired pending trades (service emits socket events internally)
      const tradesExpired = await tradesService.processExpiredTrades();

      // Process trades with completed review periods (service emits socket events internally)
      const reviewsCompleted = await tradesService.processReviewCompleteTrades();

      const durationMs = Date.now() - tickStart;
      logger.info('trade-expiration tick complete', {
        jobName: 'trade-expiration',
        tradesExpired,
        reviewsCompleted,
        durationMs,
      });
    } finally {
      // Always release advisory lock
      await client.query('SELECT pg_advisory_unlock($1)', [TRADE_EXPIRATION_LOCK_ID]);
    }
  } catch (error) {
    logger.error('trade-expiration job error', { jobName: 'trade-expiration', error });
  } finally {
    client.release();
  }
}

/**
 * Start the trade expiration job
 */
export function startTradeExpirationJob(): void {
  if (intervalId) {
    logger.warn('Trade expiration job already running');
    return;
  }

  logger.info(`Starting trade expiration job (interval: ${TRADE_CHECK_INTERVAL_MS}ms)`);

  intervalId = setInterval(async () => {
    try {
      await processTradeExpirations();
    } catch (error) {
      logger.error('trade-expiration job error', { jobName: 'trade-expiration', error });
    }
  }, TRADE_CHECK_INTERVAL_MS);
}

/**
 * Stop the trade expiration job
 */
export function stopTradeExpirationJob(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('Trade expiration job stopped');
  }
}
