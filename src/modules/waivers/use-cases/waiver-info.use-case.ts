import { Pool, PoolClient } from 'pg';
import {
  WaiverPriorityRepository,
  FaabBudgetRepository,
  WaiverWireRepository,
} from '../waivers.repository';
import type { LeagueRepository, RosterRepository } from '../../leagues/leagues.repository';
import {
  WaiverPriorityWithDetails,
  FaabBudgetWithDetails,
  WaiverWirePlayerWithDetails,
  parseWaiverSettings,
  resolveLeagueCurrentWeek,
} from '../waivers.model';
import { NotFoundException, ForbiddenException } from '../../../utils/exceptions';
import { runInTransaction } from '../../../shared/transaction-runner';

export interface WaiverInfoContext {
  db: Pool;
  priorityRepo: WaiverPriorityRepository;
  faabRepo: FaabBudgetRepository;
  waiverWireRepo: WaiverWireRepository;
  rosterRepo: RosterRepository;
  leagueRepo: LeagueRepository;
}

/**
 * Get waiver priority order for a league
 */
export async function getPriorityOrder(
  ctx: WaiverInfoContext,
  leagueId: number,
  userId: string
): Promise<WaiverPriorityWithDetails[]> {
  // Verify user is in league
  const roster = await ctx.rosterRepo.findByLeagueAndUser(leagueId, userId);
  if (!roster) {
    throw new ForbiddenException('You are not a member of this league');
  }

  const league = await ctx.leagueRepo.findById(leagueId);
  if (!league) throw new NotFoundException('League not found');

  const season = parseInt(league.season, 10);
  return ctx.priorityRepo.getByLeague(leagueId, season);
}

/**
 * Get FAAB budgets for a league
 */
export async function getFaabBudgets(
  ctx: WaiverInfoContext,
  leagueId: number,
  userId: string
): Promise<FaabBudgetWithDetails[]> {
  // Verify user is in league
  const roster = await ctx.rosterRepo.findByLeagueAndUser(leagueId, userId);
  if (!roster) {
    throw new ForbiddenException('You are not a member of this league');
  }

  const league = await ctx.leagueRepo.findById(leagueId);
  if (!league) throw new NotFoundException('League not found');

  const season = parseInt(league.season, 10);
  return ctx.faabRepo.getByLeague(leagueId, season);
}

/**
 * Get players currently on waiver wire
 */
export async function getWaiverWirePlayers(
  ctx: WaiverInfoContext,
  leagueId: number
): Promise<WaiverWirePlayerWithDetails[]> {
  const league = await ctx.leagueRepo.findById(leagueId);
  return ctx.waiverWireRepo.getByLeague(leagueId, league?.activeLeagueSeasonId);
}

/**
 * Initialize waivers for a new season
 */
export async function initializeForSeason(
  ctx: WaiverInfoContext,
  leagueId: number,
  season: number
): Promise<void> {
  const league = await ctx.leagueRepo.findById(leagueId);
  if (!league) throw new NotFoundException('League not found');

  const settings = parseWaiverSettings(league.settings);
  if (settings.waiverType === 'none') return;

  // Get all rosters in the league
  const rosters = await ctx.rosterRepo.findByLeagueId(leagueId);
  const rosterIds = rosters.map((r) => r.id);

  await runInTransaction(ctx.db, async (client) => {
    // Initialize priorities
    await ctx.priorityRepo.initializeForLeague(leagueId, season, rosterIds, client);

    // Initialize FAAB budgets if FAAB mode
    if (settings.waiverType === 'faab') {
      await ctx.faabRepo.initializeForLeague(
        leagueId,
        season,
        rosterIds,
        settings.faabBudget,
        client
      );
    }
  });
}

/**
 * Add player to waiver wire (called when player is dropped)
 */
export async function addToWaiverWire(
  ctx: WaiverInfoContext,
  leagueId: number,
  playerId: number,
  droppedByRosterId: number,
  client?: PoolClient
): Promise<void> {
  const league = await ctx.leagueRepo.findById(leagueId);
  if (!league) return;

  const settings = parseWaiverSettings(league.settings);
  if (settings.waiverType === 'none') return;

  const season = parseInt(league.season, 10);
  const currentWeek = resolveLeagueCurrentWeek(league) ?? 1;

  // Calculate expiration
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + settings.waiverPeriodDays);

  await ctx.waiverWireRepo.addPlayer(
    leagueId,
    playerId,
    droppedByRosterId,
    expiresAt,
    season,
    currentWeek,
    client
  );
}

/**
 * Check if player requires waiver claim (on waiver wire or waivers always required)
 */
export async function requiresWaiverClaim(
  ctx: WaiverInfoContext,
  leagueId: number,
  playerId: number
): Promise<boolean> {
  const league = await ctx.leagueRepo.findById(leagueId);
  if (!league) return false;

  const settings = parseWaiverSettings(league.settings);

  // If waivers are disabled, never require claim
  if (settings.waiverType === 'none') return false;

  // If player is on waiver wire, always require claim
  const isOnWaivers = await ctx.waiverWireRepo.isOnWaivers(leagueId, playerId, undefined, league?.activeLeagueSeasonId);
  if (isOnWaivers) return true;

  // In some leagues, all free agents require waivers - for now, only waiver wire players require claims
  return false;
}
