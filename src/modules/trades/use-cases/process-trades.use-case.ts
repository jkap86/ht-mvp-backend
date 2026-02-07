import { TradesRepository, TradeVotesRepository } from '../trades.repository';
import { EventTypes, tryGetEventBus } from '../../../shared/events';
import { runWithLock, LockDomain } from '../../../shared/transaction-runner';
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
      const eventBus = tryGetEventBus();
      eventBus?.publish({
        type: EventTypes.TRADE_INVALIDATED,
        leagueId: trade.leagueId,
        payload: {
          tradeId: trade.id,
          reason: 'A player involved in this trade is no longer available',
        },
      });
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
      const eventBus = tryGetEventBus();
      eventBus?.publish({
        type: EventTypes.TRADE_INVALIDATED,
        leagueId: trade.leagueId,
        payload: {
          tradeId: trade.id,
          reason: 'A draft pick involved in this trade is no longer available',
        },
      });
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
      const eventBus = tryGetEventBus();
      eventBus?.publish({
        type: EventTypes.TRADE_EXPIRED,
        leagueId: trade.leagueId,
        payload: { tradeId: trade.id },
      });
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
      logger.warn('League not found for trade, skipping', { leagueId: trade.leagueId, tradeId: trade.id });
      continue;
    }
    const vetoThreshold = league.settings?.trade_veto_count || DEFAULT_VETO_COUNT;

    // Collect events to emit AFTER commit
    let pendingEvent: 'vetoed' | 'completed' | null = null;
    let pickTradedEvents: PickTradedEvent[] = [];

    try {
      const result = await runWithLock(
        ctx.db,
        LockDomain.TRADE,
        trade.leagueId,
        async (client) => {
          // Use conditional update to ensure trade is still in 'in_review' status
          // This prevents processing a trade that was already completed or vetoed concurrently
          if (voteCount.veto >= vetoThreshold) {
            const updated = await ctx.tradesRepo.updateStatus(trade.id, 'vetoed', client, 'in_review');
            if (!updated) {
              // Trade status changed concurrently, skip
              return { skipped: true };
            }
            return { skipped: false, event: 'vetoed' as const, pickEvents: [] };
          } else {
            // Check status before executing (trade might have been vetoed concurrently)
            const lockedTrade = await ctx.tradesRepo.findById(trade.id, client);
            if (!lockedTrade || lockedTrade.status !== 'in_review') {
              return { skipped: true };
            }
            const pickEvents = await executeTrade(ctx, trade, client);
            const updated = await ctx.tradesRepo.updateStatus(
              trade.id,
              'completed',
              client,
              'in_review'
            );
            if (!updated) {
              // Trade status changed concurrently, skip
              return { skipped: true };
            }
            return { skipped: false, event: 'completed' as const, pickEvents };
          }
        }
      );

      if (result.skipped) {
        continue;
      }

      pendingEvent = result.event ?? null;
      pickTradedEvents = result.pickEvents ?? [];

      // Emit domain events AFTER successful commit
      const eventBus = tryGetEventBus();
      if (pendingEvent === 'vetoed') {
        eventBus?.publish({
          type: EventTypes.TRADE_VETOED,
          leagueId: trade.leagueId,
          payload: { tradeId: trade.id },
        });
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
        eventBus?.publish({
          type: EventTypes.TRADE_COMPLETED,
          leagueId: trade.leagueId,
          payload: { tradeId: trade.id },
        });
        for (const pickEvent of pickTradedEvents) {
          eventBus?.publish({
            type: EventTypes.PICK_TRADED,
            leagueId: pickEvent.leagueId,
            payload: {
              pickAssetId: pickEvent.pickAssetId,
              season: pickEvent.season,
              round: pickEvent.round,
              previousOwnerRosterId: pickEvent.previousOwnerRosterId,
              newOwnerRosterId: pickEvent.newOwnerRosterId,
              tradeId: pickEvent.tradeId,
            },
          });
        }
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
      logger.error('Failed to process trade', { tradeId: trade.id, error: String(error) });
    }
  }

  return processed;
}
