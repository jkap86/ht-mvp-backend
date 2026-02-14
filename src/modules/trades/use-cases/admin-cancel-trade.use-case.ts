import { Pool } from 'pg';
import { TradesRepository } from '../trades.repository';
import { EventTypes, tryGetEventBus } from '../../../shared/events';
import { TradeWithDetails } from '../trades.model';
import {
  NotFoundException,
  ValidationException,
} from '../../../utils/exceptions';
import { runWithLock, LockDomain } from '../../../shared/transaction-runner';
import type { EventListenerService } from '../../chat/event-listener.service';
import { logger } from '../../../config/logger.config';

const ALLOWED_STATUSES = ['pending', 'accepted', 'in_review'];

export interface AdminCancelTradeContext {
  db: Pool;
  tradesRepo: TradesRepository;
  eventListenerService?: EventListenerService;
}

/**
 * Commissioner cancels a trade.
 *
 * Differences from regular cancel:
 * - No proposer check (commissioner check done upstream in service)
 * - Accepts 'pending', 'accepted', and 'in_review' statuses
 *
 * LOCK CONTRACT:
 * - Acquires TRADE lock (300M + leagueId) via runWithLock
 */
export async function adminCancelTrade(
  ctx: AdminCancelTradeContext,
  leagueId: number,
  tradeId: number,
  reason?: string
): Promise<TradeWithDetails> {
  const trade = await ctx.tradesRepo.findById(tradeId);
  if (!trade) throw new NotFoundException('Trade not found');

  if (trade.leagueId !== leagueId) {
    throw new NotFoundException('Trade not found in this league');
  }

  // Initial status check (re-verified inside lock)
  if (!ALLOWED_STATUSES.includes(trade.status)) {
    throw new ValidationException(`Cannot cancel trade with status: ${trade.status}`);
  }

  await runWithLock(ctx.db, LockDomain.TRADE, leagueId, async (client) => {
    const currentTrade = await ctx.tradesRepo.findById(tradeId, client);
    if (!currentTrade) {
      throw new NotFoundException('Trade not found');
    }
    // Idempotent: if already cancelled, succeed silently
    if (currentTrade.status === 'cancelled') {
      return;
    }
    if (!ALLOWED_STATUSES.includes(currentTrade.status)) {
      throw new ValidationException(
        `Cannot cancel trade with status: ${currentTrade.status}`
      );
    }

    await ctx.tradesRepo.updateStatus(tradeId, 'cancelled', client);
  });

  const tradeWithDetails = await ctx.tradesRepo.findByIdWithDetails(tradeId);
  if (!tradeWithDetails) throw new Error('Failed to get trade details');

  // Emit domain event AFTER commit
  const eventBus = tryGetEventBus();
  eventBus?.publish({
    type: EventTypes.TRADE_CANCELLED,
    leagueId,
    payload: { tradeId: trade.id, adminCancelled: true, reason },
  });

  // Emit system message to league chat
  if (ctx.eventListenerService) {
    ctx.eventListenerService
      .handleTradeCancelled(leagueId, trade.id, trade.notifyLeagueChat)
      .catch((err) => logger.warn('Failed to emit system message', {
        type: 'admin_trade_cancelled',
        leagueId,
        tradeId: trade.id,
        error: err.message
      }));
  }

  return tradeWithDetails;
}
