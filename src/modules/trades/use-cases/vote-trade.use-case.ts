import { TradesRepository, TradeVotesRepository } from '../trades.repository';
import { LeagueRepository, RosterRepository } from '../../leagues/leagues.repository';
import { getSocketService } from '../../../socket';
import { TradeWithDetails } from '../trades.model';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
  ConflictException,
} from '../../../utils/exceptions';

const DEFAULT_VETO_COUNT = 4;

export interface VoteTradeContext {
  tradesRepo: TradesRepository;
  tradeVotesRepo: TradeVotesRepository;
  rosterRepo: RosterRepository;
  leagueRepo: LeagueRepository;
}

/**
 * Vote on a trade during review period
 */
export async function voteTrade(
  ctx: VoteTradeContext,
  tradeId: number,
  userId: string,
  vote: 'approve' | 'veto'
): Promise<{ trade: TradeWithDetails; voteCount: { approve: number; veto: number } }> {
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

  // Check if already voted
  const hasVoted = await ctx.tradeVotesRepo.hasVoted(tradeId, roster.id);
  if (hasVoted) {
    throw new ConflictException('You have already voted on this trade');
  }

  await ctx.tradeVotesRepo.create(tradeId, roster.id, vote);

  const voteCount = await ctx.tradeVotesRepo.countVotes(tradeId);

  // Check if veto threshold reached
  const league = await ctx.leagueRepo.findById(trade.leagueId);
  const vetoThreshold = league?.settings?.trade_veto_count || DEFAULT_VETO_COUNT;

  if (voteCount.veto >= vetoThreshold) {
    await ctx.tradesRepo.updateStatus(tradeId, 'vetoed');
    emitTradeVetoedEvent(trade.leagueId, trade.id);
  } else {
    emitTradeVoteCastEvent(trade.leagueId, trade.id, voteCount);
  }

  const tradeWithDetails = await ctx.tradesRepo.findByIdWithDetails(tradeId, roster.id);
  if (!tradeWithDetails) throw new Error('Failed to get trade details');

  return { trade: tradeWithDetails, voteCount };
}

function emitTradeVetoedEvent(leagueId: number, tradeId: number): void {
  try {
    const socket = getSocketService();
    socket.emitTradeVetoed(leagueId, { tradeId });
  } catch (socketError) {
    console.warn('Failed to emit trade vetoed event:', socketError);
  }
}

function emitTradeVoteCastEvent(leagueId: number, tradeId: number, votes: { approve: number; veto: number }): void {
  try {
    const socket = getSocketService();
    socket.emitTradeVoteCast(leagueId, { tradeId, votes });
  } catch (socketError) {
    console.warn('Failed to emit vote event:', socketError);
  }
}
