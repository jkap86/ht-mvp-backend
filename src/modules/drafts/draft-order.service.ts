import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { DraftRepository } from './drafts.repository';
import { DraftPickAssetRepository } from './draft-pick-asset.repository';
import { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import { ForbiddenException, NotFoundException, ValidationException } from '../../utils/exceptions';
import { EventTypes, tryGetEventBus } from '../../shared/events';
import { runWithLock, LockDomain } from '../../shared/transaction-runner';

/**
 * Cryptographically secure Fisher-Yates shuffle.
 * Uses crypto.randomBytes() with rejection sampling for unbiased randomization.
 */
function secureShuffleArray<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const range = i + 1;
    // Calculate the largest multiple of range that fits in 32 bits
    // to avoid modulo bias (2^32 isn't evenly divisible by all ranges)
    const maxUnbiased = Math.floor(0x100000000 / range) * range;

    let randomValue: number;
    do {
      const randomBuffer = randomBytes(4);
      randomValue = randomBuffer.readUInt32BE(0);
    } while (randomValue >= maxUnbiased);

    const j = randomValue % range;
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export class DraftOrderService {
  constructor(
    private readonly db: Pool,
    private readonly draftRepo: DraftRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly pickAssetRepo?: DraftPickAssetRepository
  ) {}

  async getDraftOrder(leagueId: number, draftId: number, userId: string): Promise<any[]> {
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    return this.draftRepo.getDraftOrder(draftId);
  }

  async randomizeDraftOrder(leagueId: number, draftId: number, userId: string): Promise<any[]> {
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can randomize draft order');
    }

    const draft = await this.draftRepo.findById(draftId);
    if (!draft || draft.status !== 'not_started') {
      throw new ValidationException('Can only randomize order before draft starts');
    }

    // Get league to know total roster count
    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    const targetCount = league.totalRosters;

    // Clean up and recreate empty rosters in a transaction with league lock
    await runWithLock(this.db, LockDomain.LEAGUE, leagueId, async (client) => {
      // Delete all empty rosters first (cleans up any duplicates from previous bugs)
      await this.rosterRepo.deleteEmptyRosters(leagueId, client);

      // Count rosters with actual users
      const userRosterCount = await this.rosterRepo.getRosterCount(leagueId, client);

      // Create fresh empty rosters to fill remaining slots
      for (let i = userRosterCount + 1; i <= targetCount; i++) {
        await this.rosterRepo.createEmptyRoster(leagueId, i, client);
      }
    });

    // Now get ALL rosters (including newly created empty ones)
    const allRosters = await this.rosterRepo.findByLeagueId(leagueId);
    const shuffled = secureShuffleArray(allRosters);

    // Atomically update draft order in a single transaction
    const rosterIds = shuffled.map((r) => r.id);
    await this.draftRepo.updateDraftOrderAtomic(draftId, rosterIds);

    // Update pick asset positions to match new draft order
    if (this.pickAssetRepo) {
      await this.pickAssetRepo.updatePickPositions(draftId);
    }

    // Mark order as confirmed after successful randomization
    await this.draftRepo.setOrderConfirmed(draftId, true);

    // Fetch the final draft order
    const finalOrder = await this.draftRepo.getDraftOrder(draftId);

    // Emit event to notify all users viewing the draft room (AFTER transaction completes)
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.DRAFT_ORDER_UPDATED,
      payload: {
        draftId,
        order_confirmed: true,
        draft_order: finalOrder,
      },
    });

    return finalOrder;
  }

  /**
   * Confirm the draft order without randomizing.
   * Commissioner can use this to confirm a manually arranged order.
   */
  async confirmDraftOrder(leagueId: number, draftId: number, userId: string): Promise<any[]> {
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can confirm draft order');
    }

    const draft = await this.draftRepo.findById(draftId);
    if (!draft || draft.status !== 'not_started') {
      throw new ValidationException('Can only confirm order before draft starts');
    }

    if (draft.orderConfirmed) {
      throw new ValidationException('Draft order is already confirmed');
    }

    // Verify draft order exists and is valid
    const draftOrder = await this.draftRepo.getDraftOrder(draftId);
    if (draftOrder.length === 0) {
      throw new ValidationException('Draft order not set');
    }

    // Update pick asset positions to match current draft order
    if (this.pickAssetRepo) {
      await this.pickAssetRepo.updatePickPositions(draftId);
    }

    // Mark order as confirmed
    await this.draftRepo.setOrderConfirmed(draftId, true);

    // Emit event to notify all users viewing the draft room
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.DRAFT_ORDER_UPDATED,
      payload: {
        draftId,
        order_confirmed: true,
        draft_order: draftOrder,
      },
    });

    return draftOrder;
  }

  /**
   * Set draft order based on Round 1 pick ownership from existing pick assets.
   * Used when a rookie draft is created after a vet draft distributed the picks.
   */
  async setOrderFromPickOwnership(
    leagueId: number,
    draftId: number,
    userId: string
  ): Promise<any[]> {
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can set draft order');
    }

    const draft = await this.draftRepo.findById(draftId);
    if (!draft || draft.status !== 'not_started') {
      throw new ValidationException('Can only set order before draft starts');
    }

    // Get Round 1 ownership order
    if (!this.pickAssetRepo) {
      throw new ValidationException('Pick asset repository not available');
    }

    // Get the season from pick assets linked to this draft
    const pickAssets = await this.pickAssetRepo.findByDraftId(draftId);
    if (pickAssets.length === 0) {
      throw new ValidationException('No pick assets linked to this draft. Cannot use vet draft results.');
    }
    const season = pickAssets[0].season;

    const rosterIds = await this.pickAssetRepo.getRound1OwnershipOrder(leagueId, season);
    if (rosterIds.length === 0) {
      throw new ValidationException('No Round 1 pick assets found for this season.');
    }

    // Update draft order based on pick ownership
    await this.draftRepo.updateDraftOrderAtomic(draftId, rosterIds);

    // Update pick asset positions to match new draft order
    await this.pickAssetRepo.updatePickPositions(draftId);

    // Mark order as confirmed
    await this.draftRepo.setOrderConfirmed(draftId, true);

    // Fetch the final draft order
    const finalOrder = await this.draftRepo.getDraftOrder(draftId);

    // Emit event to notify all users viewing the draft room
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.DRAFT_ORDER_UPDATED,
      payload: {
        draftId,
        order_confirmed: true,
        draft_order: finalOrder,
      },
    });

    return finalOrder;
  }

  async createInitialOrder(draftId: number, leagueId: number): Promise<void> {
    // Get league to know total roster count
    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      return;
    }

    const targetCount = league.totalRosters;

    // Clean up and create empty rosters in a transaction with league lock
    await runWithLock(this.db, LockDomain.LEAGUE, leagueId, async (client) => {
      // Delete any existing empty rosters first
      await this.rosterRepo.deleteEmptyRosters(leagueId, client);

      // Count rosters with actual users
      const userRosterCount = await this.rosterRepo.getRosterCount(leagueId, client);

      // Create fresh empty rosters to fill remaining slots
      for (let i = userRosterCount + 1; i <= targetCount; i++) {
        await this.rosterRepo.createEmptyRoster(leagueId, i, client);
      }
    });

    // Now get ALL rosters (including newly created empty ones)
    const allRosters = await this.rosterRepo.findByLeagueId(leagueId);
    if (allRosters.length === 0) {
      return;
    }

    // Use batch insert
    const rosterIds = allRosters.map((r) => r.id);
    await this.draftRepo.updateDraftOrderAtomic(draftId, rosterIds);
  }
}
