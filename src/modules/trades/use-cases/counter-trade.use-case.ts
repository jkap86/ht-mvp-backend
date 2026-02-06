import { Pool } from 'pg';
import { tryGetSocketService } from '../../../socket';
import { TradeWithDetails, CounterTradeRequest, tradeWithDetailsToResponse } from '../trades.model';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
} from '../../../utils/exceptions';
import { getLockId, LockDomain } from '../../../shared/locks';
import { proposeTrade, ProposeTradeContext } from './propose-trade.use-case';
import { EventListenerService } from '../../chat/event-listener.service';
import { logger } from '../../../config/logger.config';

export interface CounterTradeContext extends ProposeTradeContext {
  db: Pool;
  eventListenerService?: EventListenerService;
}

/**
 * Counter a trade
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

  // Initial status check (will be re-verified inside transaction)
  if (originalTrade.status !== 'pending') {
    throw new ValidationException(`Cannot counter trade with status: ${originalTrade.status}`);
  }

  // Use transaction to ensure atomicity - both status update and new trade succeed or fail together
  const client = await ctx.db.connect();
  let newTrade: TradeWithDetails;

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [
      getLockId(LockDomain.TRADE, originalTrade.leagueId),
    ]);

    // Re-verify status after acquiring lock (another transaction may have changed it)
    const currentTrade = await ctx.tradesRepo.findById(tradeId, client);
    if (!currentTrade || currentTrade.status !== 'pending') {
      throw new ValidationException(
        `Cannot counter trade with status: ${currentTrade?.status || 'unknown'}`
      );
    }

    // Mark original as countered within the transaction (conditional)
    const updated = await ctx.tradesRepo.updateStatus(tradeId, 'countered', client, 'pending');
    if (!updated) {
      throw new ValidationException('Trade status changed during processing');
    }

    // Create new trade with swapped proposer/recipient (using same transaction)
    newTrade = await proposeTrade(
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
      },
      false // Don't manage transaction - we're already in one
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  emitTradeCounteredEvent(originalTrade.leagueId, tradeId, newTrade);

  // Emit system message for the counter trade
  if (ctx.eventListenerService) {
    ctx.eventListenerService
      .handleTradeCountered(originalTrade.leagueId, newTrade.id, newTrade.notifyLeagueChat)
      .catch((err) => logger.warn('Failed to emit system message', {
        type: 'trade_countered',
        leagueId: originalTrade.leagueId,
        tradeId: newTrade.id,
        error: err.message
      }));
  }

  return newTrade;
}

function emitTradeCounteredEvent(
  leagueId: number,
  originalTradeId: number,
  newTrade: TradeWithDetails
): void {
  const socket = tryGetSocketService();
  socket?.emitTradeCountered(leagueId, {
    originalTradeId,
    newTrade: tradeWithDetailsToResponse(newTrade),
  });
}
