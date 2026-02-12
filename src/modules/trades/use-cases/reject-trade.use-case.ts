import { Pool } from 'pg';
import { TradesRepository } from '../trades.repository';
import type { RosterRepository } from '../../leagues/leagues.repository';
import { EventTypes, tryGetEventBus } from '../../../shared/events';
import { TradeWithDetails } from '../trades.model';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
} from '../../../utils/exceptions';
import { runWithLock, LockDomain } from '../../../shared/transaction-runner';
import type { EventListenerService } from '../../chat/event-listener.service';
import { logger } from '../../../config/logger.config';

export interface RejectTradeContext {
  db: Pool;
  tradesRepo: TradesRepository;
  rosterRepo: RosterRepository;
  eventListenerService?: EventListenerService;
}

/**
 * Reject a trade
 *
 * LOCK CONTRACT:
 * - Acquires TRADE lock (300M + leagueId) via runWithLock — serializes trade state changes per league
 *
 * Only one lock domain (TRADE) is acquired. No nested cross-domain advisory locks.
 */
export async function rejectTrade(
  ctx: RejectTradeContext,
  tradeId: number,
  userId: string
): Promise<TradeWithDetails> {
  const trade = await ctx.tradesRepo.findById(tradeId);
  if (!trade) throw new NotFoundException('Trade not found');

  const roster = await ctx.rosterRepo.findById(trade.recipientRosterId);
  if (!roster || roster.userId !== userId) {
    throw new ForbiddenException('Only the recipient can reject this trade');
  }

  // Initial status check (will be re-verified inside transaction)
  if (trade.status !== 'pending') {
    throw new ValidationException(`Cannot reject trade with status: ${trade.status}`);
  }

  await runWithLock(ctx.db, LockDomain.TRADE, trade.leagueId, async (client) => {
    // Re-verify status after acquiring lock (another transaction may have changed it)
    const currentTrade = await ctx.tradesRepo.findById(tradeId, client);
    if (!currentTrade) {
      throw new NotFoundException('Trade not found');
    }
    // If already rejected, silently succeed (idempotent retry)
    if (currentTrade.status === 'rejected') {
      return; // Exit early, status is already correct
    }
    // If in another state, cannot reject
    if (currentTrade.status !== 'pending') {
      throw new ValidationException(
        `Cannot reject trade with status: ${currentTrade.status}`
      );
    }

    await ctx.tradesRepo.updateStatus(tradeId, 'rejected', client);
  });

  const tradeWithDetails = await ctx.tradesRepo.findByIdWithDetails(tradeId, roster.id);
  if (!tradeWithDetails) throw new Error('Failed to get trade details');

  // Emit domain event AFTER commit
  const eventBus = tryGetEventBus();
  eventBus?.publish({
    type: EventTypes.TRADE_REJECTED,
    leagueId: trade.leagueId,
    payload: { tradeId: trade.id },
  });

  // Emit system message to league chat
  if (ctx.eventListenerService) {
    ctx.eventListenerService
      .handleTradeRejected(trade.leagueId, trade.id, trade.notifyLeagueChat)
      .catch((err) => logger.warn('Failed to emit system message', {
        type: 'trade_rejected',
        leagueId: trade.leagueId,
        tradeId: trade.id,
        error: err.message
      }));
  }

  return tradeWithDetails;
}
