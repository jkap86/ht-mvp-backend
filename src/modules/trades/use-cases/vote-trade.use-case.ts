import { Pool } from 'pg';
import { TradesRepository, TradeVotesRepository } from '../trades.repository';
import { LeagueRepository, RosterRepository } from '../../leagues/leagues.repository';
import { tryGetSocketService } from '../../../socket';
import { TradeWithDetails } from '../trades.model';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
  ConflictException,
} from '../../../utils/exceptions';
import { getTradeLockId } from '../../../utils/locks';
import { EventListenerService } from '../../chat/event-listener.service';

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
  const client = await ctx.db.connect();
  let voteCount: { approve: number; veto: number };

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [getTradeLockId(trade.leagueId)]);

    // Re-verify trade status after acquiring lock
    const lockedTrade = await ctx.tradesRepo.findById(tradeId);
    if (!lockedTrade || lockedTrade.status !== 'in_review') {
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
    voteCount = await ctx.tradeVotesRepo.countVotes(tradeId, client);

    // Check if veto threshold reached and update status atomically
    if (voteCount.veto >= vetoThreshold) {
      const updated = await ctx.tradesRepo.updateStatus(tradeId, 'vetoed', client, 'in_review');
      if (!updated) {
        throw new ValidationException('Trade status changed during vote processing');
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  // Emit events after transaction commits (outside transaction for reliability)
  if (voteCount.veto >= vetoThreshold) {
    emitTradeVetoedEvent(trade.leagueId, trade.id);
    // Emit system message for veto
    if (ctx.eventListenerService) {
      ctx.eventListenerService
        .handleTradeVetoed(trade.leagueId, trade.id)
        .catch((err) => console.error('Failed to emit trade vetoed system message:', err));
    }
  } else {
    emitTradeVoteCastEvent(trade.leagueId, trade.id, voteCount);
  }

  const tradeWithDetails = await ctx.tradesRepo.findByIdWithDetails(tradeId, roster.id);
  if (!tradeWithDetails) throw new Error('Failed to get trade details');

  return { trade: tradeWithDetails, voteCount };
}

function emitTradeVetoedEvent(leagueId: number, tradeId: number): void {
  const socket = tryGetSocketService();
  socket?.emitTradeVetoed(leagueId, { tradeId });
}

function emitTradeVoteCastEvent(
  leagueId: number,
  tradeId: number,
  votes: { approve: number; veto: number }
): void {
  const socket = tryGetSocketService();
  socket?.emitTradeVoteCast(leagueId, { tradeId, votes });
}
