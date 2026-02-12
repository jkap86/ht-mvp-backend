import { PoolClient } from 'pg';
import { TradesRepository } from './trades.repository';
import { Trade } from './trades.model';

/**
 * The set of trade statuses that are considered "active" and eligible for invalidation.
 * A trade in any of these statuses should be expired when an involved asset becomes unavailable.
 *
 * - 'pending': Trade proposed but not yet accepted
 * - 'accepted': Trade accepted but review period hasn't started yet
 * - 'in_review': Trade is in the league review/veto period
 */
export const INVALIDATABLE_TRADE_STATUSES = ['pending', 'accepted', 'in_review'] as const;

/**
 * Invalidate active trades by expiring them via conditional status update.
 * Uses a single UPDATE with IN clause to cover all invalidatable statuses atomically,
 * rather than trying each status sequentially.
 *
 * @param tradesRepo - Trades repository instance
 * @param affectedTrades - Trades to attempt to invalidate (should be pre-filtered to active statuses)
 * @param client - Database client (required, should be within an active transaction)
 * @returns Array of trades that were actually invalidated (status was successfully changed to 'expired')
 */
export async function invalidateAffectedTrades(
  tradesRepo: TradesRepository,
  affectedTrades: Trade[],
  client: PoolClient
): Promise<Array<{ id: number; leagueId: number }>> {
  const invalidated: Array<{ id: number; leagueId: number }> = [];

  for (const trade of affectedTrades) {
    // Try each invalidatable status - the trade could be in any of them.
    // updateStatus with expectedStatus uses a conditional WHERE clause,
    // so only one of these will succeed (the one matching current status).
    let updated = false;
    for (const status of INVALIDATABLE_TRADE_STATUSES) {
      const result = await tradesRepo.updateStatus(trade.id, 'expired', client, status);
      if (result) {
        updated = true;
        break;
      }
    }

    if (updated) {
      invalidated.push({ id: trade.id, leagueId: trade.leagueId });
    }
  }

  return invalidated;
}

/**
 * Find and invalidate all active trades involving a specific player.
 *
 * @param tradesRepo - Trades repository instance
 * @param leagueId - League to search within
 * @param playerId - Player whose trades should be invalidated
 * @param client - Database client (required, should be within an active transaction)
 * @returns Array of trades that were actually invalidated
 */
export async function invalidateTradesForPlayer(
  tradesRepo: TradesRepository,
  leagueId: number,
  playerId: number,
  client: PoolClient
): Promise<Array<{ id: number; leagueId: number }>> {
  const affectedTrades = await tradesRepo.findPendingByPlayer(leagueId, playerId, client);
  return invalidateAffectedTrades(tradesRepo, affectedTrades, client);
}

/**
 * Find and invalidate all active trades involving a specific pick asset.
 *
 * @param tradesRepo - Trades repository instance
 * @param leagueId - League to search within
 * @param pickAssetId - Pick asset whose trades should be invalidated
 * @param client - Database client (required, should be within an active transaction)
 * @returns Array of trades that were actually invalidated
 */
export async function invalidateTradesForPickAsset(
  tradesRepo: TradesRepository,
  leagueId: number,
  pickAssetId: number,
  client: PoolClient
): Promise<Array<{ id: number; leagueId: number }>> {
  const affectedTrades = await tradesRepo.findPendingByPickAsset(leagueId, pickAssetId, client);
  return invalidateAffectedTrades(tradesRepo, affectedTrades, client);
}
