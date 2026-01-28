import { Pool } from 'pg';
import { TradesRepository, TradeItemsRepository, TradeVotesRepository } from '../trades.repository';
import { RosterPlayersRepository, RosterTransactionsRepository } from '../../rosters/rosters.repository';
import { LeagueRepository } from '../../leagues/leagues.repository';
import { tryGetSocketService } from '../../../socket';
import { Trade } from '../trades.model';
import { getTradeLockId } from '../../../utils/locks';
import { executeTrade, AcceptTradeContext } from './accept-trade.use-case';

const DEFAULT_VETO_COUNT = 4;

export interface ProcessTradesContext extends AcceptTradeContext {
  tradeVotesRepo: TradeVotesRepository;
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
      emitTradeInvalidatedEvent(trade.leagueId, trade.id, 'A player involved in this trade is no longer available');
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
      emitTradeInvalidatedEvent(trade.leagueId, trade.id, 'A draft pick involved in this trade is no longer available');
    }
  }
}

/**
 * Process expired trades (called by job)
 * Uses conditional update to prevent overwriting trades that were accepted/rejected concurrently
 */
export async function processExpiredTrades(
  ctx: { tradesRepo: TradesRepository }
): Promise<number> {
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
export async function processReviewCompleteTrades(
  ctx: ProcessTradesContext
): Promise<number> {
  const trades = await ctx.tradesRepo.findReviewCompleteTrades();
  let processed = 0;

  for (const trade of trades) {
    const voteCount = await ctx.tradeVotesRepo.countVotes(trade.id);
    const league = await ctx.leagueRepo.findById(trade.leagueId);
    const vetoThreshold = league?.settings?.trade_veto_count || DEFAULT_VETO_COUNT;

    const client = await ctx.db.connect();
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
        emitTradeVetoedEvent(trade.leagueId, trade.id);
      } else {
        // Check status before executing (trade might have been vetoed concurrently)
        const lockedTrade = await ctx.tradesRepo.findById(trade.id);
        if (!lockedTrade || lockedTrade.status !== 'in_review') {
          await client.query('ROLLBACK');
          continue;
        }
        await executeTrade(ctx, trade, client);
        const updated = await ctx.tradesRepo.updateStatus(trade.id, 'completed', client, 'in_review');
        if (!updated) {
          // Trade status changed concurrently, skip
          await client.query('ROLLBACK');
          continue;
        }
        emitTradeCompletedEvent(trade.leagueId, trade.id);
      }

      await client.query('COMMIT');
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
