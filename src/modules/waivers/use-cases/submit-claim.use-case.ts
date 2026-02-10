import { Pool } from 'pg';
import {
  WaiverPriorityRepository,
  FaabBudgetRepository,
  WaiverClaimsRepository,
} from '../waivers.repository';
import { RosterPlayersRepository } from '../../rosters/rosters.repository';
import { LeagueRepository, RosterRepository } from '../../leagues/leagues.repository';
import { EventTypes, tryGetEventBus } from '../../../shared/events';
import {
  WaiverClaimWithDetails,
  SubmitClaimRequest,
  parseWaiverSettings,
  waiverClaimToResponse,
  resolveLeagueCurrentWeek,
} from '../waivers.model';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
  ConflictException,
} from '../../../utils/exceptions';
import { runWithLock, LockDomain } from '../../../shared/transaction-runner';

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
  request: SubmitClaimRequest,
  idempotencyKey?: string
): Promise<WaiverClaimWithDetails> {
  // Validate user owns a roster in this league (fail fast outside transaction)
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
  const currentWeek = resolveLeagueCurrentWeek(league) ?? 1;

  // Execute in transaction with lock
  const claim = await runWithLock(
    ctx.db,
    LockDomain.WAIVER,
    leagueId,
    async (client) => {
      // Idempotency check: return existing claim if same key was already used
      if (idempotencyKey) {
        const existing = await client.query(
          `SELECT id FROM waiver_claims
           WHERE league_id = $1 AND roster_id = $2 AND idempotency_key = $3`,
          [leagueId, roster.id, idempotencyKey]
        );
        if (existing.rows.length > 0) {
          const existingClaim = await ctx.claimsRepo.findByIdWithDetails(existing.rows[0].id);
          if (existingClaim) {
            return existingClaim;
          }
        }
      }

      // Check if player is already owned (season-scoped)
      const playerOwner = await ctx.rosterPlayersRepo.findOwner(leagueId, request.playerId, client, league.activeLeagueSeasonId);
      if (playerOwner) {
        throw new ValidationException('Player is already on a roster');
      }

      // Check if user already has a pending claim for this player
      const existingClaim = await ctx.claimsRepo.hasPendingClaim(roster.id, request.playerId, client);
      if (existingClaim) {
        throw new ConflictException('You already have a pending claim for this player');
      }

      // Validate FAAB bid if applicable
      const bidAmount = request.bidAmount || 0;
      if (settings.waiverType === 'faab') {
        let budget = await ctx.faabRepo.getByRoster(roster.id, season, client);
        if (!budget) {
          // Safety net for late-joining rosters: initialize with league's default budget
          await ctx.faabRepo.ensureRosterBudget(leagueId, roster.id, season, settings.faabBudget, client);
          budget = await ctx.faabRepo.getByRoster(roster.id, season, client);
          if (!budget) {
            throw new ValidationException('Failed to initialize FAAB budget');
          }
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
      let priority = await ctx.priorityRepo.getByRoster(roster.id, season, client);
      if (!priority) {
        // Safety net for late-joining rosters: initialize with last place priority
        await ctx.priorityRepo.ensureRosterPriority(leagueId, roster.id, season, client);
        priority = await ctx.priorityRepo.getByRoster(roster.id, season, client);
      }
      priorityAtClaim = priority?.priority ?? null;

      // Get next claim order for this roster (claims are processed in order)
      const nextClaimOrder = await ctx.claimsRepo.getNextClaimOrder(
        roster.id,
        season,
        currentWeek,
        client
      );

      // Create the claim
      return await ctx.claimsRepo.create(
        leagueId,
        roster.id,
        request.playerId,
        request.dropPlayerId || null,
        bidAmount,
        priorityAtClaim,
        season,
        currentWeek,
        nextClaimOrder,
        client,
        idempotencyKey
      );
    }
  );

  // Get full details for response (after transaction commits)
  const claimWithDetails = await ctx.claimsRepo.findByIdWithDetails(claim.id);
  if (!claimWithDetails) throw new Error('Failed to get claim details');

  // Emit event via domain event bus (AFTER transaction commit)
  emitClaimSubmitted(leagueId, claimWithDetails);

  return claimWithDetails;
}

function emitClaimSubmitted(leagueId: number, claim: WaiverClaimWithDetails): void {
  const eventBus = tryGetEventBus();
  eventBus?.publish({
    type: EventTypes.WAIVER_CLAIMED,
    leagueId,
    payload: waiverClaimToResponse(claim),
  });
}
