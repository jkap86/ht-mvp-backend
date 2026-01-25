import { Pool } from 'pg';
import {
  WaiverPriorityRepository,
  FaabBudgetRepository,
  WaiverClaimsRepository,
} from '../waivers.repository';
import { RosterPlayersRepository } from '../../rosters/rosters.repository';
import { LeagueRepository, RosterRepository } from '../../leagues/leagues.repository';
import { getSocketService } from '../../../socket';
import {
  WaiverClaimWithDetails,
  SubmitClaimRequest,
  parseWaiverSettings,
  waiverClaimToResponse,
} from '../waivers.model';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
  ConflictException,
} from '../../../utils/exceptions';
import { getWaiverLockId } from '../../../utils/locks';

export interface SubmitClaimContext {
  db: Pool;
  priorityRepo: WaiverPriorityRepository;
  faabRepo: FaabBudgetRepository;
  claimsRepo: WaiverClaimsRepository;
  rosterRepo: RosterRepository;
  rosterPlayersRepo: RosterPlayersRepository;
  leagueRepo: LeagueRepository;
}

/**
 * Submit a waiver claim
 */
export async function submitClaim(
  ctx: SubmitClaimContext,
  leagueId: number,
  userId: string,
  request: SubmitClaimRequest
): Promise<WaiverClaimWithDetails> {
  // Validate user owns a roster in this league
  const roster = await ctx.rosterRepo.findByLeagueAndUser(leagueId, userId);
  if (!roster) {
    throw new ForbiddenException('You are not a member of this league');
  }

  // Get league and waiver settings
  const league = await ctx.leagueRepo.findById(leagueId);
  if (!league) throw new NotFoundException('League not found');

  const settings = parseWaiverSettings(league.settings);
  if (settings.waiverType === 'none') {
    throw new ValidationException('Waivers are disabled for this league');
  }

  const season = parseInt(league.season, 10);
  const currentWeek = league.currentWeek || 1;

  const client = await ctx.db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [getWaiverLockId(leagueId)]);

    // Check if player is already owned
    const playerOwner = await ctx.rosterPlayersRepo.findOwner(leagueId, request.playerId, client);
    if (playerOwner) {
      throw new ValidationException('Player is already on a roster');
    }

    // Check if user already has a pending claim for this player
    const existingClaim = await ctx.claimsRepo.hasPendingClaim(roster.id, request.playerId, client);
    if (existingClaim) {
      throw new ConflictException('You already have a pending claim for this player');
    }

    // Validate FAAB bid if applicable
    let bidAmount = request.bidAmount || 0;
    if (settings.waiverType === 'faab') {
      const budget = await ctx.faabRepo.getByRoster(roster.id, season, client);
      if (!budget) {
        throw new ValidationException('FAAB budget not initialized');
      }
      if (bidAmount > budget.remainingBudget) {
        throw new ValidationException(`Bid exceeds available budget ($${budget.remainingBudget})`);
      }
      if (bidAmount < 0) {
        throw new ValidationException('Bid amount cannot be negative');
      }
    }

    // Validate drop player if provided
    if (request.dropPlayerId) {
      const hasPlayer = await ctx.rosterPlayersRepo.findByRosterAndPlayer(
        roster.id,
        request.dropPlayerId,
        client
      );
      if (!hasPlayer) {
        throw new ValidationException('You do not own the player to drop');
      }
    }

    // Get priority snapshot for ALL claim types (used as tiebreaker in FAAB mode)
    let priorityAtClaim: number | null = null;
    const priority = await ctx.priorityRepo.getByRoster(roster.id, season, client);
    priorityAtClaim = priority?.priority ?? null;

    // Create the claim
    const claim = await ctx.claimsRepo.create(
      leagueId,
      roster.id,
      request.playerId,
      request.dropPlayerId || null,
      bidAmount,
      priorityAtClaim,
      season,
      currentWeek,
      client
    );

    await client.query('COMMIT');

    // Get full details for response
    const claimWithDetails = await ctx.claimsRepo.findByIdWithDetails(claim.id);
    if (!claimWithDetails) throw new Error('Failed to get claim details');

    // Emit socket event
    emitClaimSubmitted(leagueId, claimWithDetails);

    return claimWithDetails;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function emitClaimSubmitted(leagueId: number, claim: WaiverClaimWithDetails): void {
  try {
    const socket = getSocketService();
    socket.emitWaiverClaimSubmitted(leagueId, waiverClaimToResponse(claim));
  } catch (socketError) {
    console.warn('Failed to emit waiver claim submitted event:', socketError);
  }
}
