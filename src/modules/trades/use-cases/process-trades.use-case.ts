import { TradesRepository, TradeVotesRepository } from '../trades.repository';
import { tryGetSocketService } from '../../../socket';
import { getTradeLockId } from '../../../utils/locks';
import { executeTrade, AcceptTradeContext, PickTradedEvent } from './accept-trade.use-case';
import { EventListenerService } from '../../chat/event-listener.service';
import { logger } from '../../../config/logger.config';

const DEFAULT_VETO_COUNT = 4;

export interface ProcessTradesContext extends AcceptTradeContext {
  tradeVotesRepo: TradeVotesRepository;
  eventListenerService?: EventListenerService;
}

/**
 * Invalidate pending trades containing a dropped player
 * Uses conditional updates to handle concurrent modifications safely
 */
export async function invalidateTradesWithPlayer(
  ctx: { tradesRepo: TradesRepository },
  leagueId: number,
  playerId: number
): Promise<void> {
  const pendingTrades = await ctx.tradesRepo.findPendingByPlayer(leagueId, playerId);

  for (const trade of pendingTrades) {
    // Try to expire - only succeeds if still in an active state
    // Try 'pending' first, then 'in_review' if that fails
    let updated = await ctx.tradesRepo.updateStatus(trade.id, 'expired', undefined, 'pending');
    if (!updated) {
      updated = await ctx.tradesRepo.updateStatus(trade.id, 'expired', undefined, 'in_review');
    }

    if (updated) {
      emitTradeInvalidatedEvent(
        trade.leagueId,
        trade.id,
        'A player involved in this trade is no longer available'
      );
    }
  }
}

/**
 * Invalidate pending trades containing a pick asset that is no longer tradeable
 * (e.g., pick was used, round passed)
 * Uses conditional updates to handle concurrent modifications safely
 */
export async function invalidateTradesWithPick(
  ctx: { tradesRepo: TradesRepository },
  leagueId: number,
  pickAssetId: number
): Promise<void> {
  const pendingTrades = await ctx.tradesRepo.findPendingByPickAsset(leagueId, pickAssetId);

  for (const trade of pendingTrades) {
    // Try to expire - only succeeds if still in an active state
    // Try 'pending' first, then 'in_review' if that fails
    let updated = await ctx.tradesRepo.updateStatus(trade.id, 'expired', undefined, 'pending');
    if (!updated) {
      updated = await ctx.tradesRepo.updateStatus(trade.id, 'expired', undefined, 'in_review');
    }

    if (updated) {
      emitTradeInvalidatedEvent(
        trade.leagueId,
        trade.id,
        'A draft pick involved in this trade is no longer available'
      );
    }
  }
}

/**
 * Process expired trades (called by job)
 * Uses conditional update to prevent overwriting trades that were accepted/rejected concurrently
 */
export async function processExpiredTrades(ctx: { tradesRepo: TradesRepository }): Promise<number> {
  const expired = await ctx.tradesRepo.findExpiredTrades();
  let expiredCount = 0;

  for (const trade of expired) {
    // Conditional update - only expire if still pending
    const updated = await ctx.tradesRepo.updateStatus(trade.id, 'expired', undefined, 'pending');

    if (updated) {
      expiredCount++;
      emitTradeExpiredEvent(trade.leagueId, trade.id);
    }
    // If not updated, trade was already accepted/rejected/etc - skip silently
  }

  return expiredCount;
}

/**
 * Process trades with completed review period (called by job)
 */
export async function processReviewCompleteTrades(ctx: ProcessTradesContext): Promise<number> {
  const trades = await ctx.tradesRepo.findReviewCompleteTrades();
  let processed = 0;

  for (const trade of trades) {
    const voteCount = await ctx.tradeVotesRepo.countVotes(trade.id);
    const league = await ctx.leagueRepo.findById(trade.leagueId);
    if (!league) {
      console.warn(`League ${trade.leagueId} not found for trade ${trade.id}, skipping`);
      continue;
    }
    const vetoThreshold = league.settings?.trade_veto_count || DEFAULT_VETO_COUNT;

    const client = await ctx.db.connect();
    // Collect events to emit AFTER commit
    let pendingEvent: 'vetoed' | 'completed' | null = null;
    let pickTradedEvents: PickTradedEvent[] = [];

    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [getTradeLockId(trade.leagueId)]);

      // Use conditional update to ensure trade is still in 'in_review' status
      // This prevents processing a trade that was already completed or vetoed concurrently
      if (voteCount.veto >= vetoThreshold) {
        const updated = await ctx.tradesRepo.updateStatus(trade.id, 'vetoed', client, 'in_review');
        if (!updated) {
          // Trade status changed concurrently, skip
          await client.query('ROLLBACK');
          continue;
        }
        pendingEvent = 'vetoed';
      } else {
        // Check status before executing (trade might have been vetoed concurrently)
        const lockedTrade = await ctx.tradesRepo.findById(trade.id);
        if (!lockedTrade || lockedTrade.status !== 'in_review') {
          await client.query('ROLLBACK');
          continue;
        }
        pickTradedEvents = await executeTrade(ctx, trade, client);
        const updated = await ctx.tradesRepo.updateStatus(
          trade.id,
          'completed',
          client,
          'in_review'
        );
        if (!updated) {
          // Trade status changed concurrently, skip
          await client.query('ROLLBACK');
          continue;
        }
        pendingEvent = 'completed';
      }

      await client.query('COMMIT');

      // Emit events AFTER successful commit
      if (pendingEvent === 'vetoed') {
        emitTradeVetoedEvent(trade.leagueId, trade.id);
        // Emit system message for veto
        if (ctx.eventListenerService) {
          ctx.eventListenerService
            .handleTradeVetoed(trade.leagueId, trade.id)
            .catch((err) => logger.warn('Failed to emit system message', {
              type: 'trade_vetoed',
              leagueId: trade.leagueId,
              tradeId: trade.id,
              error: err.message
            }));
        }
      } else if (pendingEvent === 'completed') {
        emitTradeCompletedEvent(trade.leagueId, trade.id);
        emitPickTradedEvents(pickTradedEvents);
        // Emit system message for completion
        if (ctx.eventListenerService) {
          ctx.eventListenerService
            .handleTradeAccepted(trade.leagueId, trade.id, true)
            .catch((err) => logger.warn('Failed to emit system message', {
              type: 'trade_completed',
              leagueId: trade.leagueId,
              tradeId: trade.id,
              error: err.message
            }));
        }
      }

      processed++;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`Failed to process trade ${trade.id}:`, error);
    } finally {
      client.release();
    }
  }

  return processed;
}

function emitTradeInvalidatedEvent(leagueId: number, tradeId: number, reason: string): void {
  const socket = tryGetSocketService();
  socket?.emitTradeInvalidated(leagueId, {
    tradeId,
    reason,
  });
}

function emitTradeExpiredEvent(leagueId: number, tradeId: number): void {
  const socket = tryGetSocketService();
  socket?.emitTradeExpired(leagueId, { tradeId });
}

function emitTradeVetoedEvent(leagueId: number, tradeId: number): void {
  const socket = tryGetSocketService();
  socket?.emitTradeVetoed(leagueId, { tradeId });
}

function emitTradeCompletedEvent(leagueId: number, tradeId: number): void {
  const socket = tryGetSocketService();
  socket?.emitTradeCompleted(leagueId, { tradeId });
}

function emitPickTradedEvents(events: PickTradedEvent[]): void {
  if (events.length === 0) return;
  const socket = tryGetSocketService();
  for (const event of events) {
    socket?.emitPickTraded(event.leagueId, {
      pickAssetId: event.pickAssetId,
      season: event.season,
      round: event.round,
      previousOwnerRosterId: event.previousOwnerRosterId,
      newOwnerRosterId: event.newOwnerRosterId,
      tradeId: event.tradeId,
    });
  }
}
