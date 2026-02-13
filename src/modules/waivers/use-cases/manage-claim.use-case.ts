import type { Pool } from 'pg';
import { FaabBudgetRepository, WaiverClaimsRepository } from '../waivers.repository';
import type { RosterPlayersRepository } from '../../rosters/rosters.repository';
import type { LeagueRepository, RosterRepository } from '../../leagues/leagues.repository';
import { EventTypes, tryGetEventBus } from '../../../shared/events';
import { runWithLock, LockDomain } from '../../../shared/transaction-runner';
import {
  WaiverClaimWithDetails,
  UpdateClaimRequest,
  parseWaiverSettings,
  waiverClaimToResponse,
  resolveLeagueCurrentWeek,
} from '../waivers.model';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
} from '../../../utils/exceptions';

export interface ManageClaimContext {
  db: Pool;
  faabRepo: FaabBudgetRepository;
  claimsRepo: WaiverClaimsRepository;
  rosterRepo: RosterRepository;
  rosterPlayersRepo: RosterPlayersRepository;
  leagueRepo: LeagueRepository;
}

/**
 * Get pending claims for current user
 */
export async function getMyClaims(
  ctx: ManageClaimContext,
  leagueId: number,
  userId: string
): Promise<WaiverClaimWithDetails[]> {
  const roster = await ctx.rosterRepo.findByLeagueAndUser(leagueId, userId);
  if (!roster) {
    throw new ForbiddenException('You are not a member of this league');
  }

  return ctx.claimsRepo.getPendingByRoster(roster.id);
}

/**
 * Cancel a pending claim
 *
 * LOCK CONTRACT:
 * - Acquires WAIVER lock (400M + leagueId) via runWithLock -- serializes with other waiver operations
 * - Uses conditional update (WHERE status = 'pending') to prevent race with concurrent waiver processing
 *
 * Only one lock domain (WAIVER) is acquired. No nested cross-domain advisory locks.
 */
export async function cancelClaim(
  ctx: ManageClaimContext,
  claimId: number,
  userId: string
): Promise<void> {
  // Fail-fast validations outside the transaction (ownership, existence)
  const claim = await ctx.claimsRepo.findById(claimId);
  if (!claim) {
    throw new NotFoundException('Claim not found');
  }

  const roster = await ctx.rosterRepo.findById(claim.rosterId);
  if (!roster || roster.userId !== userId) {
    throw new ForbiddenException('You do not own this claim');
  }

  if (claim.status !== 'pending') {
    throw new ValidationException('Can only cancel pending claims');
  }

  // Execute conditional cancel within WAIVER lock
  const cancelled = await runWithLock(
    ctx.db,
    LockDomain.WAIVER,
    claim.leagueId,
    async (client) => {
      // Conditional update: only cancel if still pending
      return ctx.claimsRepo.cancelIfPending(claimId, client);
    }
  );

  if (!cancelled) {
    throw new ValidationException('Claim is no longer pending (it may have been processed)');
  }

  // Emit event AFTER transaction commit
  emitClaimCancelled(claim.leagueId, claimId, claim.rosterId);
}

/**
 * Update claim bid amount or drop player
 *
 * LOCK CONTRACT:
 * - Acquires WAIVER lock (400M + leagueId) via runWithLock -- serializes FAAB budget reads
 *   Prevents concurrent updateClaim calls from both reading the same budget and overcommitting FAAB
 *
 * Only one lock domain (WAIVER) is acquired. No nested cross-domain advisory locks.
 */
export async function updateClaim(
  ctx: ManageClaimContext,
  claimId: number,
  userId: string,
  request: UpdateClaimRequest
): Promise<WaiverClaimWithDetails> {
  // Fail-fast validations outside the transaction
  const claim = await ctx.claimsRepo.findById(claimId);
  if (!claim) {
    throw new NotFoundException('Claim not found');
  }

  const roster = await ctx.rosterRepo.findById(claim.rosterId);
  if (!roster || roster.userId !== userId) {
    throw new ForbiddenException('You do not own this claim');
  }

  if (claim.status !== 'pending') {
    throw new ValidationException('Can only update pending claims');
  }

  const league = await ctx.leagueRepo.findById(claim.leagueId);
  if (!league) throw new NotFoundException('League not found');

  const settings = parseWaiverSettings(league.settings);
  const season = parseInt(league.season, 10);

  const currentWeek = resolveLeagueCurrentWeek(league);
  if (currentWeek === null) {
    throw new ValidationException("Waivers aren't available until the season starts (Week 1).");
  }

  // Execute update within WAIVER lock for consistent budget reads
  await runWithLock(
    ctx.db,
    LockDomain.WAIVER,
    claim.leagueId,
    async (client) => {
      // Re-check status inside the lock to ensure claim is still pending
      const freshClaim = await ctx.claimsRepo.findById(claimId, client);
      if (!freshClaim || freshClaim.status !== 'pending') {
        throw new ValidationException('Claim is no longer pending');
      }

      // Update bid amount if provided
      if (request.bidAmount !== undefined && settings.waiverType === 'faab') {
        const budget = await ctx.faabRepo.getByRoster(roster.id, season, client);
        if (!budget) {
          throw new ValidationException('FAAB budget not initialized');
        }
        // Add back the old bid to get actual available budget
        const existingBid = freshClaim.bidAmount;
        const availableBudget = budget.remainingBudget + existingBid;
        if (request.bidAmount > availableBudget) {
          throw new ValidationException(`Bid exceeds available budget ($${availableBudget})`);
        }
        if (request.bidAmount < 0) {
          throw new ValidationException('Bid amount cannot be negative');
        }
        await ctx.claimsRepo.updateBid(claimId, request.bidAmount, client);
      }

      // Update drop player if provided
      if (request.dropPlayerId !== undefined) {
        if (request.dropPlayerId !== null) {
          const hasPlayer = await ctx.rosterPlayersRepo.findByRosterAndPlayer(
            roster.id,
            request.dropPlayerId,
            client
          );
          if (!hasPlayer) {
            throw new ValidationException('You do not own the player to drop');
          }
        }
        await ctx.claimsRepo.updateDropPlayer(claimId, request.dropPlayerId, client);
      }
    }
  );

  // Fetch details AFTER transaction commit for consistent read
  const claimWithDetails = await ctx.claimsRepo.findByIdWithDetails(claimId);
  if (!claimWithDetails) throw new Error('Failed to get claim details');

  // Emit event AFTER transaction commit
  emitClaimUpdated(claim.leagueId, claimWithDetails);

  return claimWithDetails;
}

/**
 * Reorder pending claims for a roster
 *
 * LOCK CONTRACT:
 * - Acquires WAIVER lock (400M + leagueId) via runWithLock -- serializes with concurrent
 *   claim submissions and waiver processing to prevent read-validate-write races
 *
 * Only one lock domain (WAIVER) is acquired. No nested cross-domain advisory locks.
 */
export async function reorderClaims(
  ctx: ManageClaimContext,
  leagueId: number,
  userId: string,
  claimIds: number[]
): Promise<WaiverClaimWithDetails[]> {
  // Fail-fast validations outside the transaction
  const roster = await ctx.rosterRepo.findByLeagueAndUser(leagueId, userId);
  if (!roster) {
    throw new ForbiddenException('You are not a member of this league');
  }

  const league = await ctx.leagueRepo.findById(leagueId);
  if (!league) throw new NotFoundException('League not found');
  const currentWeek = resolveLeagueCurrentWeek(league);
  if (currentWeek === null) {
    throw new ValidationException("Waivers aren't available until the season starts (Week 1).");
  }

  if (!claimIds || claimIds.length === 0) {
    throw new ValidationException('Must provide at least one claim ID');
  }

  // Check for duplicates (cheap validation, no DB needed)
  const uniqueIds = new Set(claimIds);
  if (uniqueIds.size !== claimIds.length) {
    throw new ValidationException('Duplicate claim IDs are not allowed');
  }

  // Execute read-validate-write within WAIVER lock
  await runWithLock(
    ctx.db,
    LockDomain.WAIVER,
    leagueId,
    async (client) => {
      // Get all pending claims inside the lock for a consistent snapshot
      const pendingClaims = await ctx.claimsRepo.getPendingByRoster(roster.id, client);
      const pendingIds = new Set(pendingClaims.map((c) => c.id));

      // Check that all provided claim IDs are valid pending claims for this roster
      for (const claimId of claimIds) {
        if (!pendingIds.has(claimId)) {
          throw new ValidationException(`Claim ${claimId} is not a valid pending claim for your roster`);
        }
      }

      // Check that all pending claims are included (no partial reorder)
      if (claimIds.length !== pendingClaims.length) {
        throw new ValidationException(
          `Must provide all ${pendingClaims.length} pending claim IDs. Received ${claimIds.length}.`
        );
      }

      // Perform the reorder
      await ctx.claimsRepo.reorderClaims(roster.id, claimIds, client);
    }
  );

  // Fetch updated claims AFTER transaction commit
  const updatedClaims = await ctx.claimsRepo.getPendingByRoster(roster.id);

  // Emit event AFTER transaction commit
  emitClaimsReordered(leagueId, roster.id, updatedClaims);

  return updatedClaims;
}

function emitClaimCancelled(leagueId: number, claimId: number, rosterId: number): void {
  const eventBus = tryGetEventBus();
  eventBus?.publish({
    type: EventTypes.WAIVER_CLAIM_CANCELLED,
    leagueId,
    payload: { claimId, rosterId },
  });
}

function emitClaimUpdated(leagueId: number, claim: WaiverClaimWithDetails): void {
  const eventBus = tryGetEventBus();
  eventBus?.publish({
    type: EventTypes.WAIVER_CLAIM_UPDATED,
    leagueId,
    payload: waiverClaimToResponse(claim),
  });
}

function emitClaimsReordered(
  leagueId: number,
  rosterId: number,
  claims: WaiverClaimWithDetails[]
): void {
  const eventBus = tryGetEventBus();
  eventBus?.publish({
    type: EventTypes.WAIVER_CLAIMS_REORDERED,
    leagueId,
    payload: {
      rosterId,
      claims: claims.map(waiverClaimToResponse),
    },
  });
}
