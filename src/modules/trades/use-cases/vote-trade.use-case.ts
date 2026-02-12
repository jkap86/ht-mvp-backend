import { Pool } from 'pg';
import { TradesRepository, TradeVotesRepository } from '../trades.repository';
import type { LeagueRepository, RosterRepository } from '../../leagues/leagues.repository';
import { EventTypes, tryGetEventBus } from '../../../shared/events';
import { TradeWithDetails } from '../trades.model';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
  ConflictException,
} from '../../../utils/exceptions';
import { runWithLock, LockDomain } from '../../../shared/transaction-runner';
import type { EventListenerService } from '../../chat/event-listener.service';
import { logger } from '../../../config/logger.config';

const DEFAULT_VETO_COUNT = 4;

export interface VoteTradeContext {
  db: Pool;
  tradesRepo: TradesRepository;
  tradeVotesRepo: TradeVotesRepository;
  rosterRepo: RosterRepository;
  leagueRepo: LeagueRepository;
  eventListenerService?: EventListenerService;
}

/**
 * Vote on a trade during review period
 * Uses transaction with advisory lock to prevent race conditions in vote counting
 *
 * LOCK CONTRACT:
 * - Acquires TRADE lock (300M + leagueId) via runWithLock — serializes vote counting per league
 *   May also update trade status to 'vetoed' if veto threshold is reached (inside same lock)
 *
 * Only one lock domain (TRADE) is acquired. No nested cross-domain advisory locks.
 */
export async function voteTrade(
  ctx: VoteTradeContext,
  tradeId: number,
  userId: string,
  vote: 'approve' | 'veto'
): Promise<{ trade: TradeWithDetails; voteCount: { approve: number; veto: number } }> {
  // Pre-transaction validation (read-only)
  const trade = await ctx.tradesRepo.findById(tradeId);
  if (!trade) throw new NotFoundException('Trade not found');

  if (trade.status !== 'in_review') {
    throw new ValidationException('Trade is not in review period');
  }

  // Get user's roster
  const roster = await ctx.rosterRepo.findByLeagueAndUser(trade.leagueId, userId);
  if (!roster) {
    throw new ForbiddenException('You are not a member of this league');
  }

  // Cannot vote on own trade
  if (roster.id === trade.proposerRosterId || roster.id === trade.recipientRosterId) {
    throw new ForbiddenException('Cannot vote on your own trade');
  }

  // Get league settings before transaction
  const league = await ctx.leagueRepo.findById(trade.leagueId);
  const vetoThreshold = league?.settings?.trade_veto_count || DEFAULT_VETO_COUNT;

  // Use transaction with advisory lock to prevent race conditions
  const voteCount = await runWithLock(
    ctx.db,
    LockDomain.TRADE,
    trade.leagueId,
    async (client) => {
      // Re-verify trade status after acquiring lock
      const lockedTrade = await ctx.tradesRepo.findById(tradeId, client);
      if (!lockedTrade) {
        throw new NotFoundException('Trade not found');
      }
      // If trade was already vetoed or completed, return current counts (idempotent)
      if (lockedTrade.status === 'vetoed' || lockedTrade.status === 'completed') {
        const counts = await ctx.tradeVotesRepo.countVotes(tradeId, client);
        return counts;
      }
      // If no longer in review, cannot vote
      if (lockedTrade.status !== 'in_review') {
        throw new ValidationException('Trade is no longer in review period');
      }

      // Check if already voted (within transaction)
      const hasVoted = await ctx.tradeVotesRepo.hasVoted(tradeId, roster.id, client);
      if (hasVoted) {
        throw new ConflictException('You have already voted on this trade');
      }

      // Create vote
      await ctx.tradeVotesRepo.create(tradeId, roster.id, vote, client);

      // Count votes atomically within the same transaction
      const counts = await ctx.tradeVotesRepo.countVotes(tradeId, client);

      // Check if veto threshold reached and update status atomically
      if (counts.veto >= vetoThreshold) {
        const updated = await ctx.tradesRepo.updateStatus(tradeId, 'vetoed', client, 'in_review');
        if (!updated) {
          throw new ValidationException('Trade status changed during vote processing');
        }
      }

      return counts;
    }
  );

  // Emit domain events after transaction commits (outside transaction for reliability)
  const eventBus = tryGetEventBus();
  if (voteCount.veto >= vetoThreshold) {
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
  } else {
    eventBus?.publish({
      type: EventTypes.TRADE_VOTE_CAST,
      leagueId: trade.leagueId,
      payload: { tradeId: trade.id, votes: voteCount },
    });
  }

  const tradeWithDetails = await ctx.tradesRepo.findByIdWithDetails(tradeId, roster.id);
  if (!tradeWithDetails) throw new Error('Failed to get trade details');

  return { trade: tradeWithDetails, voteCount };
}
