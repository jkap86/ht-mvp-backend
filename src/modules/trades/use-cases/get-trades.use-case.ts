import { TradesRepository } from '../trades.repository';
import { LeagueRepository, RosterRepository } from '../../leagues/leagues.repository';
import { TradeWithDetails } from '../trades.model';
import {
  NotFoundException,
  ForbiddenException,
} from '../../../utils/exceptions';

export interface GetTradesContext {
  tradesRepo: TradesRepository;
  rosterRepo: RosterRepository;
  leagueRepo: LeagueRepository;
}

/**
 * Get trades for a league
 */
export async function getTradesForLeague(
  ctx: GetTradesContext,
  leagueId: number,
  userId: string,
  statuses?: string[],
  limit?: number,
  offset?: number
): Promise<TradeWithDetails[]> {
  const isMember = await ctx.leagueRepo.isUserMember(leagueId, userId);
  if (!isMember) throw new ForbiddenException('Not a league member');

  const roster = await ctx.rosterRepo.findByLeagueAndUser(leagueId, userId);
  const trades = await ctx.tradesRepo.findByLeague(
    leagueId,
    statuses as any[],
    limit,
    offset
  );

  const tradesWithDetails: TradeWithDetails[] = [];
  for (const trade of trades) {
    const details = await ctx.tradesRepo.findByIdWithDetails(trade.id, roster?.id);
    if (details) tradesWithDetails.push(details);
  }

  return tradesWithDetails;
}

/**
 * Get a single trade with details
 */
export async function getTradeById(
  ctx: GetTradesContext,
  tradeId: number,
  userId: string
): Promise<TradeWithDetails> {
  const trade = await ctx.tradesRepo.findById(tradeId);
  if (!trade) throw new NotFoundException('Trade not found');

  const isMember = await ctx.leagueRepo.isUserMember(trade.leagueId, userId);
  if (!isMember) throw new ForbiddenException('Not a league member');

  const roster = await ctx.rosterRepo.findByLeagueAndUser(trade.leagueId, userId);
  const details = await ctx.tradesRepo.findByIdWithDetails(tradeId, roster?.id);
  if (!details) throw new NotFoundException('Trade not found');

  return details;
}
