import { FaabBudgetRepository, WaiverClaimsRepository } from '../waivers.repository';
import { RosterPlayersRepository } from '../../rosters/rosters.repository';
import { LeagueRepository, RosterRepository } from '../../leagues/leagues.repository';
import { tryGetSocketService } from '../../../socket';
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

  // Emit socket event
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

  // Emit socket event
  emitClaimUpdated(claim.leagueId, claimWithDetails);

  return claimWithDetails;
}

function emitClaimCancelled(leagueId: number, claimId: number, rosterId: number): void {
  const socket = tryGetSocketService();
  socket?.emitWaiverClaimCancelled(leagueId, { claimId, rosterId });
}

function emitClaimUpdated(leagueId: number, claim: WaiverClaimWithDetails): void {
  const socket = tryGetSocketService();
  socket?.emitWaiverClaimUpdated(leagueId, waiverClaimToResponse(claim));
}
