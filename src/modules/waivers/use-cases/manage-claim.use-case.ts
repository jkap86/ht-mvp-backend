import { FaabBudgetRepository, WaiverClaimsRepository } from '../waivers.repository';
import type { RosterPlayersRepository } from '../../rosters/rosters.repository';
import type { LeagueRepository, RosterRepository } from '../../leagues/leagues.repository';
import { EventTypes, tryGetEventBus } from '../../../shared/events';
import {
  WaiverClaimWithDetails,
  UpdateClaimRequest,
  parseWaiverSettings,
  waiverClaimToResponse,
} from '../waivers.model';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
} from '../../../utils/exceptions';

export interface ManageClaimContext {
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
 */
export async function cancelClaim(
  ctx: ManageClaimContext,
  claimId: number,
  userId: string
): Promise<void> {
  const claim = await ctx.claimsRepo.findById(claimId);
  if (!claim) {
    throw new NotFoundException('Claim not found');
  }

  // Verify ownership
  const roster = await ctx.rosterRepo.findById(claim.rosterId);
  if (!roster || roster.userId !== userId) {
    throw new ForbiddenException('You do not own this claim');
  }

  if (claim.status !== 'pending') {
    throw new ValidationException('Can only cancel pending claims');
  }

  await ctx.claimsRepo.updateStatus(claimId, 'cancelled');

  // Emit event via domain event bus
  emitClaimCancelled(claim.leagueId, claimId, claim.rosterId);
}

/**
 * Update claim bid amount or drop player
 */
export async function updateClaim(
  ctx: ManageClaimContext,
  claimId: number,
  userId: string,
  request: UpdateClaimRequest
): Promise<WaiverClaimWithDetails> {
  const claim = await ctx.claimsRepo.findById(claimId);
  if (!claim) {
    throw new NotFoundException('Claim not found');
  }

  // Verify ownership
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

  // Update bid amount if provided
  if (request.bidAmount !== undefined && settings.waiverType === 'faab') {
    const budget = await ctx.faabRepo.getByRoster(roster.id, season);
    if (!budget) {
      throw new ValidationException('FAAB budget not initialized');
    }
    // Add back the old bid to get actual available budget
    const existingBid = claim.bidAmount;
    const availableBudget = budget.remainingBudget + existingBid;
    if (request.bidAmount > availableBudget) {
      throw new ValidationException(`Bid exceeds available budget ($${availableBudget})`);
    }
    if (request.bidAmount < 0) {
      throw new ValidationException('Bid amount cannot be negative');
    }
    await ctx.claimsRepo.updateBid(claimId, request.bidAmount);
  }

  // Update drop player if provided
  if (request.dropPlayerId !== undefined) {
    if (request.dropPlayerId !== null) {
      const hasPlayer = await ctx.rosterPlayersRepo.findByRosterAndPlayer(
        roster.id,
        request.dropPlayerId
      );
      if (!hasPlayer) {
        throw new ValidationException('You do not own the player to drop');
      }
    }
    await ctx.claimsRepo.updateDropPlayer(claimId, request.dropPlayerId);
  }

  const claimWithDetails = await ctx.claimsRepo.findByIdWithDetails(claimId);
  if (!claimWithDetails) throw new Error('Failed to get claim details');

  // Emit event via domain event bus
  emitClaimUpdated(claim.leagueId, claimWithDetails);

  return claimWithDetails;
}

/**
 * Reorder pending claims for a roster
 */
export async function reorderClaims(
  ctx: ManageClaimContext,
  leagueId: number,
  userId: string,
  claimIds: number[]
): Promise<WaiverClaimWithDetails[]> {
  // Verify user owns a roster in this league
  const roster = await ctx.rosterRepo.findByLeagueAndUser(leagueId, userId);
  if (!roster) {
    throw new ForbiddenException('You are not a member of this league');
  }

  // Validate claim_ids is not empty
  if (!claimIds || claimIds.length === 0) {
    throw new ValidationException('Must provide at least one claim ID');
  }

  // Get all pending claims for this roster
  const pendingClaims = await ctx.claimsRepo.getPendingByRoster(roster.id);
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

  // Check for duplicates
  const uniqueIds = new Set(claimIds);
  if (uniqueIds.size !== claimIds.length) {
    throw new ValidationException('Duplicate claim IDs are not allowed');
  }

  // Perform the reorder
  await ctx.claimsRepo.reorderClaims(roster.id, claimIds);

  // Fetch updated claims with details
  const updatedClaims = await ctx.claimsRepo.getPendingByRoster(roster.id);

  // Emit event
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
