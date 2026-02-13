import { TradesRepository } from '../trades.repository';
import type { LeagueRepository, RosterRepository } from '../../leagues/leagues.repository';
import { TradeWithDetails } from '../trades.model';
import { NotFoundException, ForbiddenException } from '../../../utils/exceptions';

export interface GetTradesContext {
  tradesRepo: TradesRepository;
  rosterRepo: RosterRepository;
  leagueRepo: LeagueRepository;
}

/**
 * Get trades for a league
 * Uses optimized batch fetch to avoid N+1 queries
 */
export async function getTradesForLeague(
  ctx: GetTradesContext,
  leagueId: number,
  userId: string,
  statuses?: string[],
  limit?: number,
  offset?: number,
  leagueSeasonId?: number
): Promise<TradeWithDetails[]> {
  const isMember = await ctx.leagueRepo.isUserMember(leagueId, userId);
  if (!isMember) throw new ForbiddenException('Not a league member');

  const roster = await ctx.rosterRepo.findByLeagueAndUser(leagueId, userId);

  // Use batch fetch method to avoid N+1 queries
  return ctx.tradesRepo.findByLeagueWithDetails(
    leagueId,
    roster?.id,
    statuses as any[],
    limit,
    offset,
    leagueSeasonId
  );
}

/**
 * Get a single trade with details
 */
export async function getTradeById(
  ctx: GetTradesContext,
  tradeId: number,
  userId: string,
  leagueId: number
): Promise<TradeWithDetails> {
  const trade = await ctx.tradesRepo.findById(tradeId);
  if (!trade) throw new NotFoundException('Trade not found');

  // Verify trade belongs to the requested league
  if (trade.leagueId !== leagueId) {
    throw new NotFoundException('Trade not found');
  }

  const isMember = await ctx.leagueRepo.isUserMember(trade.leagueId, userId);
  if (!isMember) throw new ForbiddenException('Not a league member');

  const roster = await ctx.rosterRepo.findByLeagueAndUser(trade.leagueId, userId);
  const details = await ctx.tradesRepo.findByIdWithDetails(tradeId, roster?.id);
  if (!details) throw new NotFoundException('Trade not found');

  return details;
}
