import { Pool } from 'pg';
import { TradesRepository } from '../trades.repository';
import { RosterRepository } from '../../leagues/leagues.repository';
import { tryGetSocketService } from '../../../socket';
import { TradeWithDetails } from '../trades.model';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
} from '../../../utils/exceptions';
import { getTradeLockId } from '../../../utils/locks';

export interface CancelTradeContext {
  db: Pool;
  tradesRepo: TradesRepository;
  rosterRepo: RosterRepository;
}

/**
 * Cancel a trade (proposer only)
 */
export async function cancelTrade(
  ctx: CancelTradeContext,
  tradeId: number,
  userId: string
): Promise<TradeWithDetails> {
  const trade = await ctx.tradesRepo.findById(tradeId);
  if (!trade) throw new NotFoundException('Trade not found');

  const roster = await ctx.rosterRepo.findById(trade.proposerRosterId);
  if (!roster || roster.userId !== userId) {
    throw new ForbiddenException('Only the proposer can cancel this trade');
  }

  // Initial status check (will be re-verified inside transaction)
  if (trade.status !== 'pending') {
    throw new ValidationException(`Cannot cancel trade with status: ${trade.status}`);
  }

  const client = await ctx.db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [getTradeLockId(trade.leagueId)]);

    // Re-verify status after acquiring lock (another transaction may have changed it)
    const currentTrade = await ctx.tradesRepo.findById(tradeId, client);
    if (!currentTrade || currentTrade.status !== 'pending') {
      throw new ValidationException(`Cannot cancel trade with status: ${currentTrade?.status || 'unknown'}`);
    }

    await ctx.tradesRepo.updateStatus(tradeId, 'cancelled', client);

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const tradeWithDetails = await ctx.tradesRepo.findByIdWithDetails(tradeId, roster.id);
  if (!tradeWithDetails) throw new Error('Failed to get trade details');

  emitTradeCancelledEvent(trade.leagueId, trade.id);

  return tradeWithDetails;
}

function emitTradeCancelledEvent(leagueId: number, tradeId: number): void {
  const socket = tryGetSocketService();
  socket?.emitTradeCancelled(leagueId, { tradeId });
}
