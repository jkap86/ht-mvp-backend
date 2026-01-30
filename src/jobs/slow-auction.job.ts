import { Pool } from 'pg';
import { container, KEYS } from '../container';
import { SlowAuctionService } from '../modules/drafts/auction/slow-auction.service';
import { FastAuctionService } from '../modules/drafts/auction/fast-auction.service';
import { tryGetSocketService } from '../socket/socket.service';
import { logger } from '../config/logger.config';

let intervalId: NodeJS.Timeout | null = null;

const SETTLEMENT_INTERVAL_MS = 5000; // 5 seconds for faster settlement
const SLOW_AUCTION_LOCK_ID = 999999004;

async function processExpiredLots(): Promise<void> {
  const pool = container.resolve<Pool>(KEYS.POOL);
  const client = await pool.connect();
  const tickStart = Date.now();
  let lotsSettled = 0;
  let lotsPassed = 0;

  try {
    // Try to acquire advisory lock (non-blocking)
    const lockResult = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) as acquired',
      [SLOW_AUCTION_LOCK_ID]
    );

    if (!lockResult.rows[0].acquired) {
      // Another instance has the lock, skip this tick
      logger.debug('slow-auction lock not acquired, skipping', { jobName: 'slow-auction' });
      return;
    }

    logger.debug('slow-auction tick started', { jobName: 'slow-auction' });

    try {
      const slowAuctionService = container.resolve<SlowAuctionService>(KEYS.SLOW_AUCTION_SERVICE);
      const results = await slowAuctionService.processExpiredLots();

      for (const result of results) {
        if (result.winner) {
          lotsSettled++;
          logger.info(
            `Lot ${result.lot.id} settled: player ${result.lot.playerId} ` +
              `won by roster ${result.winner.rosterId} for $${result.winner.amount}`
          );
        } else {
          lotsPassed++;
          logger.info(
            `Lot ${result.lot.id} passed: player ${result.lot.playerId} received no bids`
          );
        }

        // Emit socket events
        const socket = tryGetSocketService();

        if (result.passed) {
          // Lot passed (no bids)
          socket?.emitAuctionLotPassed(result.lot.draftId, {
            lotId: result.lot.id,
            playerId: result.lot.playerId,
          });
        } else {
          // Lot won
          socket?.emitAuctionLotWon(result.lot.draftId, {
            lotId: result.lot.id,
            playerId: result.lot.playerId,
            winnerRosterId: result.winner!.rosterId,
            price: result.winner!.amount,
          });
        }

        // Advance nominator for fast auctions with retry logic
        const fastAuctionService = container.resolve<FastAuctionService>(
          KEYS.FAST_AUCTION_SERVICE
        );
        const MAX_ADVANCEMENT_RETRIES = 3;
        let advancementSuccess = false;

        for (let attempt = 1; attempt <= MAX_ADVANCEMENT_RETRIES; attempt++) {
          try {
            await fastAuctionService.advanceNominator(result.lot.draftId);
            advancementSuccess = true;
            break;
          } catch (error) {
            logger.warn('Nominator advancement attempt failed', {
              jobName: 'slow-auction',
              draftId: result.lot.draftId,
              attempt,
              maxAttempts: MAX_ADVANCEMENT_RETRIES,
              error,
            });
            if (attempt < MAX_ADVANCEMENT_RETRIES) {
              // Wait 100ms before retry
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          }
        }

        if (!advancementSuccess) {
          logger.error('All nominator advancement attempts failed', {
            jobName: 'slow-auction',
            draftId: result.lot.draftId,
            maxAttempts: MAX_ADVANCEMENT_RETRIES,
          });
        }
      }

      const durationMs = Date.now() - tickStart;
      logger.info('slow-auction tick complete', {
        jobName: 'slow-auction',
        lotsSettled,
        lotsPassed,
        durationMs,
      });
    } finally {
      // Always release advisory lock
      await client.query('SELECT pg_advisory_unlock($1)', [SLOW_AUCTION_LOCK_ID]);
    }
  } catch (error) {
    logger.error('slow-auction job error', { jobName: 'slow-auction', error });
  } finally {
    client.release();
  }
}

export function startSlowAuctionJob(): void {
  if (intervalId) {
    logger.warn('Slow auction job already running');
    return;
  }

  logger.info(`Starting slow auction job (interval: ${SETTLEMENT_INTERVAL_MS}ms)`);

  intervalId = setInterval(async () => {
    try {
      await processExpiredLots();
    } catch (error) {
      logger.error('slow-auction job error', { jobName: 'slow-auction', error });
    }
  }, SETTLEMENT_INTERVAL_MS);
}

export function stopSlowAuctionJob(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('Slow auction job stopped');
  }
}
