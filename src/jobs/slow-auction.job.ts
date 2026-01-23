import { Pool } from 'pg';
import { container, KEYS } from '../container';
import { SlowAuctionService } from '../modules/drafts/auction/slow-auction.service';
import { getSocketService } from '../socket/socket.service';
import { SOCKET_EVENTS } from '../constants/socket-events';
import { logger } from '../config/env.config';

let intervalId: NodeJS.Timeout | null = null;

const SETTLEMENT_INTERVAL_MS = 30000; // 30 seconds
const SLOW_AUCTION_LOCK_ID = 999998;

async function processExpiredLots(): Promise<void> {
  const pool = container.resolve<Pool>(KEYS.POOL);
  const client = await pool.connect();

  try {
    // Try to acquire advisory lock (non-blocking)
    const lockResult = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) as acquired',
      [SLOW_AUCTION_LOCK_ID]
    );

    if (!lockResult.rows[0].acquired) {
      // Another instance has the lock, skip this tick
      return;
    }

    try {
      const slowAuctionService = container.resolve<SlowAuctionService>(KEYS.SLOW_AUCTION_SERVICE);
      const results = await slowAuctionService.processExpiredLots();

      for (const result of results) {
        if (result.winner) {
          logger.info(
            `Lot ${result.lot.id} settled: player ${result.lot.playerId} ` +
            `won by roster ${result.winner.rosterId} for $${result.winner.amount}`
          );
        } else {
          logger.info(
            `Lot ${result.lot.id} passed: player ${result.lot.playerId} received no bids`
          );
        }

        // Emit socket events
        try {
          const socket = getSocketService();
          socket.getIO().to(`draft:${result.lot.draftId}`).emit(
            SOCKET_EVENTS.AUCTION.LOT_WON,
            {
              lotId: result.lot.id,
              draftId: result.lot.draftId,
              playerId: result.lot.playerId,
              winnerRosterId: result.winner?.rosterId ?? null,
              price: result.winner?.amount ?? 0,
              passed: result.passed,
            }
          );
        } catch (socketError) {
          logger.warn(`Failed to emit lot settlement event for lot ${result.lot.id}: ${socketError}`);
        }
      }
    } finally {
      // Always release advisory lock
      await client.query('SELECT pg_advisory_unlock($1)', [SLOW_AUCTION_LOCK_ID]);
    }
  } catch (error) {
    logger.error(`Slow auction job error: ${error}`);
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
      logger.error(`Slow auction job tick error: ${error}`);
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
