import { Pool } from 'pg';
import { EventTypes, tryGetEventBus } from '../../../shared/events';
import { TradeWithDetails, CounterTradeRequest, tradeWithDetailsToResponse } from '../trades.model';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
} from '../../../utils/exceptions';
import { runWithLock, LockDomain } from '../../../shared/transaction-runner';
import { proposeTrade, ProposeTradeContext } from './propose-trade.use-case';
import type { EventListenerService } from '../../chat/event-listener.service';
import { logger } from '../../../config/logger.config';

export interface CounterTradeContext extends ProposeTradeContext {
  db: Pool;
  eventListenerService?: EventListenerService;
}

/**
 * Counter a trade
 *
 * LOCK CONTRACT:
 * - Acquires TRADE lock (300M + leagueId) via runWithLock — serializes trade state changes per league
 * - Calls proposeTrade() inside the same TRADE lock transaction (no additional locks)
 *
 * Only one lock domain (TRADE) is acquired. No nested cross-domain advisory locks.
 */
export async function counterTrade(
  ctx: CounterTradeContext,
  tradeId: number,
  userId: string,
  request: CounterTradeRequest
): Promise<TradeWithDetails> {
  const originalTrade = await ctx.tradesRepo.findById(tradeId);
  if (!originalTrade) throw new NotFoundException('Trade not found');

  const recipientRoster = await ctx.rosterRepo.findById(originalTrade.recipientRosterId);
  if (!recipientRoster || recipientRoster.userId !== userId) {
    throw new ForbiddenException('Only the recipient can counter this trade');
  }

  // Allow idempotent retry — if already countered with idempotency key, let ON CONFLICT resolve
  if (originalTrade.status === 'countered' && !request.idempotencyKey) {
    throw new ValidationException(`Cannot counter trade with status: ${originalTrade.status}`);
  }
  // Initial status check (will be re-verified inside transaction)
  if (originalTrade.status !== 'pending' && originalTrade.status !== 'countered') {
    throw new ValidationException(`Cannot counter trade with status: ${originalTrade.status}`);
  }

  // Use transaction to ensure atomicity - both status update and new trade succeed or fail together
  const { tradeWithDetails: newTrade, isNew } = await runWithLock(
    ctx.db,
    LockDomain.TRADE,
    originalTrade.leagueId,
    async (client) => {
      // Re-verify status after acquiring lock (another transaction may have changed it)
      const currentTrade = await ctx.tradesRepo.findById(tradeId, client);
      if (!currentTrade) {
        throw new NotFoundException('Trade not found');
      }

      if (currentTrade.status === 'countered') {
        // Already countered — proposeTrade with idempotencyKey will find existing counter trade
      } else if (currentTrade.status !== 'pending') {
        throw new ValidationException(
          `Cannot counter trade with status: ${currentTrade.status}`
        );
      } else {
        // Mark original as countered within the transaction (conditional)
        const updated = await ctx.tradesRepo.updateStatus(tradeId, 'countered', client, 'pending');
        if (!updated) {
          throw new ValidationException('Trade status changed during processing');
        }
      }

      // Create new trade with swapped proposer/recipient (using same transaction)
      // On replay, ON CONFLICT resolves via idempotencyKey → isNew: false
      return await proposeTrade(
        ctx,
        client,
        originalTrade.leagueId,
        userId,
        {
          recipientRosterId: originalTrade.proposerRosterId,
          offeringPlayerIds: request.offeringPlayerIds,
          requestingPlayerIds: request.requestingPlayerIds,
          offeringPickAssetIds: request.offeringPickAssetIds,
          requestingPickAssetIds: request.requestingPickAssetIds,
          message: request.message,
          notifyDm: request.notifyDm,
          leagueChatMode: request.leagueChatMode,
          idempotencyKey: request.idempotencyKey,
        },
        false // Don't manage transaction - we're already in one
      );
    }
  );

  // Only emit events for genuinely new counter trades
  if (isNew) {
    // Emit domain event AFTER commit
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.TRADE_COUNTERED,
      leagueId: originalTrade.leagueId,
      payload: {
        originalTradeId: tradeId,
        newTrade: tradeWithDetailsToResponse(newTrade),
      },
    });

    // Emit system message for the counter trade
    if (ctx.eventListenerService) {
      ctx.eventListenerService
        .handleTradeCountered(originalTrade.leagueId, newTrade.id, {
          notifyLeagueChat: newTrade.notifyLeagueChat,
          leagueChatMode: newTrade.leagueChatMode,
          notifyDm: newTrade.notifyDm,
        })
        .catch((err) => logger.warn('Failed to emit system message', {
          type: 'trade_countered',
          leagueId: originalTrade.leagueId,
          tradeId: newTrade.id,
          error: err.message
        }));
    }
  }

  return newTrade;
}
