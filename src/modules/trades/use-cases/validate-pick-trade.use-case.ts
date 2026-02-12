import type { DraftPickAssetRepository } from '../../drafts/draft-pick-asset.repository';
import type { DraftPickAssetWithDetails } from '../../drafts/draft-pick-asset.model';
import {
  ValidationException,
  ConflictException,
  NotFoundException,
} from '../../../utils/exceptions';

export interface ValidatePickTradeContext {
  pickAssetRepo: DraftPickAssetRepository;
}

export interface PickValidationResult {
  asset: DraftPickAssetWithDetails;
  fromRosterId: number;
  toRosterId: number;
}

/**
 * Validate draft pick assets for a trade
 * - Checks ownership (current_owner_roster_id matches expected owner)
 * - Checks pick not in another pending trade
 * - Checks pick not already used (if draft in progress)
 * - Checks round hasn't passed (if draft in progress)
 *
 * @param ctx - Repository context
 * @param offeringPickAssetIds - Pick asset IDs the proposer is offering
 * @param requestingPickAssetIds - Pick asset IDs the proposer is requesting from recipient
 * @param proposerRosterId - The roster ID of the trade proposer
 * @param recipientRosterId - The roster ID of the trade recipient
 * @param leagueId - The league ID for the trade
 * @returns Array of validated pick items ready to be inserted as trade items
 */
export async function validatePickTrade(
  ctx: ValidatePickTradeContext,
  offeringPickAssetIds: number[],
  requestingPickAssetIds: number[],
  proposerRosterId: number,
  recipientRosterId: number,
  leagueId: number
): Promise<PickValidationResult[]> {
  const validatedPicks: PickValidationResult[] = [];

  // Validate offering picks (proposer -> recipient)
  for (const assetId of offeringPickAssetIds) {
    const asset = await validateSinglePick(ctx, assetId, proposerRosterId, leagueId, 'offering');
    validatedPicks.push({
      asset,
      fromRosterId: proposerRosterId,
      toRosterId: recipientRosterId,
    });
  }

  // Validate requesting picks (recipient -> proposer)
  for (const assetId of requestingPickAssetIds) {
    const asset = await validateSinglePick(ctx, assetId, recipientRosterId, leagueId, 'requesting');
    validatedPicks.push({
      asset,
      fromRosterId: recipientRosterId,
      toRosterId: proposerRosterId,
    });
  }

  return validatedPicks;
}

/**
 * Validate a single draft pick asset
 */
async function validateSinglePick(
  ctx: ValidatePickTradeContext,
  assetId: number,
  expectedOwnerRosterId: number,
  leagueId: number,
  direction: 'offering' | 'requesting'
): Promise<DraftPickAssetWithDetails> {
  // Get the pick asset with details
  const asset = await ctx.pickAssetRepo.findByIdWithDetails(assetId);
  if (!asset) {
    throw new NotFoundException(`Draft pick asset ${assetId} not found`);
  }

  // Verify the pick belongs to the expected league
  if (asset.leagueId !== leagueId) {
    throw new ValidationException(`Draft pick ${assetId} does not belong to this league`);
  }

  // Verify ownership
  if (asset.currentOwnerRosterId !== expectedOwnerRosterId) {
    const ownerDescription = direction === 'offering' ? 'You do' : 'Recipient does';
    throw new ValidationException(
      `${ownerDescription} not own draft pick: ${asset.season} Round ${asset.round} (${asset.originalTeamName}'s pick)`
    );
  }

  // Check if pick is in another pending trade
  const inPendingTrade = await ctx.pickAssetRepo.isInPendingTrade(assetId);
  if (inPendingTrade) {
    throw new ConflictException(
      `Draft pick ${asset.season} Round ${asset.round} (${asset.originalTeamName}'s pick) is already in a pending trade`
    );
  }

  // Only check draft-related validations if the pick has a draft assigned
  // (Future picks in dynasty leagues have draftId = null)
  if (asset.draftId !== null) {
    // Check if pick has already been used (player selected with it)
    const isUsed = await ctx.pickAssetRepo.isPickUsed(assetId);
    if (isUsed) {
      throw new ValidationException(
        `Draft pick ${asset.season} Round ${asset.round} (${asset.originalTeamName}'s pick) has already been used`
      );
    }

    // Check if the round has already passed in the draft
    const roundPassed = await ctx.pickAssetRepo.isRoundPassed(assetId);
    if (roundPassed) {
      throw new ValidationException(
        `Draft pick ${asset.season} Round ${asset.round} (${asset.originalTeamName}'s pick) cannot be traded - round has passed`
      );
    }
  }

  return asset;
}

/**
 * Build trade item data for validated pick assets
 */
export function buildPickTradeItems(validatedPicks: PickValidationResult[]): Array<{
  itemType: 'draft_pick';
  draftPickAssetId: number;
  pickSeason: number;
  pickRound: number;
  pickOriginalTeam: string;
  fromRosterId: number;
  toRosterId: number;
}> {
  return validatedPicks.map((pick) => ({
    itemType: 'draft_pick' as const,
    draftPickAssetId: pick.asset.id,
    pickSeason: pick.asset.season,
    pickRound: pick.asset.round,
    pickOriginalTeam: pick.asset.originalTeamName,
    fromRosterId: pick.fromRosterId,
    toRosterId: pick.toRosterId,
  }));
}
