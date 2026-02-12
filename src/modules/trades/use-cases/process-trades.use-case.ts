import { PoolClient } from 'pg';
import { TradesRepository, TradeVotesRepository } from '../trades.repository';
import { Trade } from '../trades.model';
import { EventTypes, tryGetEventBus } from '../../../shared/events';
import { runWithLock, LockDomain } from '../../../shared/transaction-runner';
import { executeTrade, AcceptTradeContext, PickTradedEvent } from './accept-trade.use-case';
import type { EventListenerService } from '../../chat/event-listener.service';
import { getMaxRosterSize } from '../../../shared/roster-defaults';
import { logger } from '../../../config/logger.config';
import { invalidateTradesForPlayer, invalidateTradesForPickAsset } from '../trade-invalidation.utils';

const DEFAULT_VETO_COUNT = 4;

export interface ProcessTradesContext extends AcceptTradeContext {
  tradeVotesRepo: TradeVotesRepository;
  eventListenerService?: EventListenerService;
}

/**
 * Invalidate active trades containing a dropped player.
 * Uses TRADE lock to prevent race conditions during invalidation.
 *
 * LOCK CONTRACT:
 * - Acquires TRADE lock (300M + leagueId) via runWithLock -- serializes trade invalidation per league
 *
 * Only one lock domain (TRADE) is acquired. No nested cross-domain advisory locks.
 */
export async function invalidateTradesWithPlayer(
  ctx: { tradesRepo: TradesRepository; db: import('pg').Pool },
  leagueId: number,
  playerId: number
): Promise<void> {
  // Collect trades that were invalidated to emit events after commit
  let invalidatedTrades: Array<{ id: number; leagueId: number }> = [];

  await runWithLock(ctx.db, LockDomain.TRADE, leagueId, async (client) => {
    invalidatedTrades = await invalidateTradesForPlayer(ctx.tradesRepo, leagueId, playerId, client);
  });

  // Emit events AFTER transaction commits (per gotchas.md)
  const eventBus = tryGetEventBus();
  for (const trade of invalidatedTrades) {
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

/**
 * Invalidate active trades containing a pick asset that is no longer tradeable
 * (e.g., pick was used, round passed).
 * Uses TRADE lock to prevent race conditions during invalidation.
 *
 * LOCK CONTRACT:
 * - Acquires TRADE lock (300M + leagueId) via runWithLock -- serializes trade invalidation per league
 *
 * Only one lock domain (TRADE) is acquired. No nested cross-domain advisory locks.
 */
export async function invalidateTradesWithPick(
  ctx: { tradesRepo: TradesRepository; db: import('pg').Pool },
  leagueId: number,
  pickAssetId: number
): Promise<void> {
  // Collect trades that were invalidated to emit events after commit
  let invalidatedTrades: Array<{ id: number; leagueId: number }> = [];

  await runWithLock(ctx.db, LockDomain.TRADE, leagueId, async (client) => {
    invalidatedTrades = await invalidateTradesForPickAsset(ctx.tradesRepo, leagueId, pickAssetId, client);
  });

  // Emit events AFTER transaction commits (per gotchas.md)
  const eventBus = tryGetEventBus();
  for (const trade of invalidatedTrades) {
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

/**
 * Process expired trades (called by job)
 * Uses conditional update to prevent overwriting trades that were accepted/rejected concurrently
 *
 * LOCK CONTRACT:
 * - No advisory locks acquired. Uses conditional SQL updates (WHERE status = 'pending')
 *   for optimistic concurrency control instead of advisory locks.
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
 *
 * LOCK CONTRACT:
 * - Acquires TRADE lock (300M + leagueId) via runWithLock per trade — serializes trade completion
 * - executeTrade() runs inside the same TRADE lock (no additional advisory locks)
 *
 * Only one lock domain (TRADE) is acquired per trade. No nested cross-domain advisory locks.
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
    let pendingEvent: 'vetoed' | 'completed' | 'failed' | null = null;
    let pickTradedEvents: PickTradedEvent[] = [];
    let failureReason: string | undefined;

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

            // Re-validate roster sizes before execution — rosters may have changed
            // during the review period (via waivers, free agency, etc.)
            const rosterSizeError = await validateRosterSizesForTrade(ctx, trade, league, client);
            if (rosterSizeError) {
              const updated = await ctx.tradesRepo.updateStatusWithReason(
                trade.id,
                'failed',
                rosterSizeError,
                client,
                'in_review'
              );
              if (!updated) {
                return { skipped: true };
              }
              return { skipped: false, event: 'failed' as const, pickEvents: [], reason: rosterSizeError };
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
      failureReason = (result as { reason?: string }).reason;

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
      } else if (pendingEvent === 'failed') {
        eventBus?.publish({
          type: EventTypes.TRADE_FAILED,
          leagueId: trade.leagueId,
          payload: { tradeId: trade.id, reason: failureReason || 'Trade could not be executed' },
        });
        logger.warn('Trade failed roster size validation after review period', {
          tradeId: trade.id,
          leagueId: trade.leagueId,
          reason: failureReason,
        });
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

/**
 * Validate that roster sizes can accommodate the trade at execution time.
 * Calculates the net player change per roster and checks against the max roster size.
 *
 * Returns null if validation passes, or a descriptive error message if it fails.
 */
async function validateRosterSizesForTrade(
  ctx: ProcessTradesContext,
  trade: Trade,
  league: { settings: Record<string, any> },
  client: PoolClient
): Promise<string | null> {
  const items = await ctx.tradeItemsRepo.findByTrade(trade.id, client);
  const playerItems = items.filter((item) => item.itemType === 'player' && item.playerId);

  // No player items means no roster size impact (pick-only trades)
  if (playerItems.length === 0) return null;

  // Calculate net player change per roster (players gained - players lost)
  const netChangeByRoster = new Map<number, number>();
  for (const item of playerItems) {
    netChangeByRoster.set(item.fromRosterId, (netChangeByRoster.get(item.fromRosterId) || 0) - 1);
    netChangeByRoster.set(item.toRosterId, (netChangeByRoster.get(item.toRosterId) || 0) + 1);
  }

  const maxRosterSize = getMaxRosterSize(league.settings);

  // Only check rosters that would gain players (net positive change)
  for (const [rosterId, netChange] of netChangeByRoster) {
    if (netChange <= 0) continue;

    const currentSize = await ctx.rosterPlayersRepo.getPlayerCount(rosterId, client);
    const projectedSize = currentSize + netChange;

    if (projectedSize > maxRosterSize) {
      return (
        `Trade cannot be completed: roster ${rosterId} would have ${projectedSize} players ` +
        `(currently ${currentSize}, gaining ${netChange} net), which exceeds the league limit of ${maxRosterSize}. ` +
        `Roster sizes changed during the review period.`
      );
    }
  }

  return null;
}
