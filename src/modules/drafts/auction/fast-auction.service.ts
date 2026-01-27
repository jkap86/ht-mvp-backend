import { Pool } from 'pg';
import { AuctionLotRepository } from './auction-lot.repository';
import { DraftRepository } from '../drafts.repository';
import { RosterRepository, LeagueRepository } from '../../leagues/leagues.repository';
import { DraftOrderService } from '../draft-order.service';
import { tryGetSocketService } from '../../../socket/socket.service';
import { PlayerRepository } from '../../players/players.repository';
import { AuctionLot, AuctionProxyBid, auctionLotFromDatabase, auctionLotToResponse } from './auction.models';
import { ValidationException, NotFoundException, ForbiddenException } from '../../../utils/exceptions';
import { getAuctionRosterLockId } from '../../../utils/locks';
import { Draft } from '../drafts.model';
import { getRosterBudgetDataWithClient } from './auction-budget-calculator';
import { resolvePriceWithClient } from './auction-price-resolver';

export interface NominationResult {
  lot: AuctionLot;
  message: string;
}

export interface SetMaxBidResult {
  proxyBid: AuctionProxyBid;
  lot: AuctionLot;
  outbidNotifications: Array<{ userId: string; lotId: number; playerId: number }>;
  message: string;
}

export interface FastAuctionSettings {
  auctionMode: 'fast' | 'slow';
  nominationSeconds: number;
  resetOnBidSeconds: number;
  minBid: number;
  minIncrement: number;
}

export interface FastAuctionState {
  auctionMode: 'fast';
  activeLot: AuctionLot | null;
  currentNominatorRosterId: number;
  nominationNumber: number;
  budgets: Array<{ rosterId: number; spent: number; remaining: number }>;
}

export class FastAuctionService {
  constructor(
    private readonly lotRepo: AuctionLotRepository,
    private readonly draftRepo: DraftRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly orderService: DraftOrderService,
    private readonly playerRepo: PlayerRepository,
    private readonly pool: Pool
  ) {}

  /**
   * Get fast auction settings from draft settings with defaults
   */
  getSettings(draft: Draft): FastAuctionSettings {
    return {
      auctionMode: draft.settings?.auctionMode ?? 'slow',
      nominationSeconds: draft.settings?.nominationSeconds ?? 60,
      resetOnBidSeconds: draft.settings?.resetOnBidSeconds ?? 15,
      minBid: draft.settings?.minBid ?? 1,
      minIncrement: draft.settings?.minIncrement ?? 1,
    };
  }

  /**
   * Get the current nominator for a fast auction draft
   */
  async getCurrentNominator(draftId: number): Promise<{ rosterId: number; userId: string } | null> {
    const draft = await this.draftRepo.findById(draftId);
    if (!draft || !draft.currentRosterId) {
      return null;
    }
    const roster = await this.rosterRepo.findById(draft.currentRosterId);
    if (!roster || !roster.userId) {
      return null;
    }
    return { rosterId: roster.id, userId: roster.userId };
  }

  /**
   * Nominate a player in fast auction mode
   * - Only current nominator can nominate
   * - Only one active lot allowed at a time
   */
  async nominate(draftId: number, userId: string, playerId: number): Promise<NominationResult> {
    // Get draft and validate
    const draft = await this.draftRepo.findById(draftId);
    if (!draft) {
      throw new NotFoundException('Draft not found');
    }
    if (draft.status !== 'in_progress') {
      throw new ValidationException('Draft is not in progress');
    }
    if (draft.draftType !== 'auction') {
      throw new ValidationException('Draft is not an auction draft');
    }

    const settings = this.getSettings(draft);
    if (settings.auctionMode !== 'fast') {
      throw new ValidationException('This is not a fast auction draft');
    }

    // Check if user is current nominator
    const roster = await this.rosterRepo.findByLeagueAndUser(draft.leagueId, userId);
    if (!roster) {
      throw new ForbiddenException('You are not a member of this league');
    }
    if (draft.currentRosterId !== roster.id) {
      throw new ForbiddenException('It is not your turn to nominate');
    }

    // Check no active lot exists
    const activeLots = await this.lotRepo.findActiveLotsByDraft(draftId);
    if (activeLots.length > 0) {
      throw new ValidationException('There is already an active lot - wait for it to complete');
    }

    // Validate player
    const player = await this.playerRepo.findById(playerId);
    if (!player) {
      throw new NotFoundException('Player not found');
    }

    // Check player not already drafted
    const isDrafted = await this.draftRepo.isPlayerDrafted(draftId, playerId);
    if (isDrafted) {
      throw new ValidationException('Player has already been drafted');
    }

    // Check player not already nominated (active or won lot)
    const existingLot = await this.lotRepo.findLotByDraftAndPlayer(draftId, playerId);
    if (existingLot) {
      throw new ValidationException('Player has already been nominated in this draft');
    }

    // Validate budget and roster slots
    const budgetInfo = await this.lotRepo.getRosterBudgetData(draftId, roster.id);
    const league = await this.leagueRepo.findById(draft.leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    const rosterSlots = league.leagueSettings?.rosterSlots ?? 15;

    // Check roster has slots
    if (budgetInfo.wonCount >= rosterSlots) {
      throw new ValidationException('Your roster is full');
    }

    // Calculate bid deadline for fast auction
    const bidDeadline = new Date(Date.now() + settings.nominationSeconds * 1000);

    // Create the lot
    const lot = await this.lotRepo.createLot(
      draftId,
      playerId,
      roster.id,
      bidDeadline,
      settings.minBid
    );

    // Emit socket event - convert to snake_case for frontend consistency
    const socket = tryGetSocketService();
    socket?.emitAuctionLotCreated(draftId, { lot: auctionLotToResponse(lot) });

    return {
      lot,
      message: `${player.fullName} nominated for $${settings.minBid}`,
    };
  }

  /**
   * Set max bid in fast auction mode
   * Reuses slow auction logic but adds timer reset on price/leader change
   */
  async setMaxBid(
    draftId: number,
    userId: string,
    lotId: number,
    maxBid: number
  ): Promise<SetMaxBidResult> {
    // Get draft and validate fast auction mode
    const draft = await this.draftRepo.findById(draftId);
    if (!draft) {
      throw new NotFoundException('Draft not found');
    }

    const settings = this.getSettings(draft);
    if (settings.auctionMode !== 'fast') {
      throw new ValidationException('This is not a fast auction draft');
    }

    // Use transaction for atomic operations
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Acquire roster-level lock to prevent cross-lot race conditions
      const roster = await this.rosterRepo.findByLeagueAndUser(draft.leagueId, userId);
      if (!roster) {
        throw new ForbiddenException('You are not a member of this league');
      }
      await client.query('SELECT pg_advisory_xact_lock($1)', [getAuctionRosterLockId(roster.id)]);

      // Get lot with lock
      const lotResult = await client.query(
        'SELECT * FROM auction_lots WHERE id = $1 FOR UPDATE',
        [lotId]
      );
      if (lotResult.rows.length === 0) {
        throw new NotFoundException('Lot not found');
      }
      const lot = auctionLotFromDatabase(lotResult.rows[0]);

      if (lot.draftId !== draftId) {
        throw new NotFoundException('Lot does not belong to this draft');
      }
      if (lot.status !== 'active') {
        throw new ValidationException('Lot is no longer active');
      }

      // Validate bid meets minimum
      const minRequired = lot.currentBid + settings.minIncrement;
      if (maxBid < minRequired && lot.currentBidderRosterId !== roster.id) {
        throw new ValidationException(`Bid must be at least $${minRequired}`);
      }

      // Validate budget
      const league = await this.leagueRepo.findById(draft.leagueId);
      if (!league) {
        throw new NotFoundException('League not found');
      }

      const totalBudget = league.leagueSettings?.auctionBudget ?? 200;
      const rosterSlots = league.leagueSettings?.rosterSlots ?? 15;
      const budgetInfo = await getRosterBudgetDataWithClient(client, draftId, roster.id);

      // Calculate remaining slots and required reserve
      const remainingSlots = rosterSlots - budgetInfo.wonCount - 1; // -1 for this lot
      const requiredReserve = Math.max(0, remainingSlots) * settings.minBid;

      // Calculate max affordable bid
      let maxAffordable = totalBudget - budgetInfo.spent - requiredReserve - budgetInfo.leadingCommitment;
      const isLeadingThisLot = lot.currentBidderRosterId === roster.id;
      if (isLeadingThisLot) {
        maxAffordable += lot.currentBid; // Can reuse current commitment
      }

      if (maxBid > maxAffordable) {
        throw new ValidationException(`Maximum affordable bid is $${maxAffordable}`);
      }

      // Upsert proxy bid
      await client.query(
        `INSERT INTO auction_proxy_bids (lot_id, roster_id, max_bid)
         VALUES ($1, $2, $3)
         ON CONFLICT (lot_id, roster_id)
         DO UPDATE SET max_bid = EXCLUDED.max_bid, updated_at = CURRENT_TIMESTAMP`,
        [lotId, roster.id, maxBid]
      );

      // Resolve price using shared utility
      const result = await resolvePriceWithClient(client, lot, settings);

      // Fast auction specific: reset timer on price/leader change
      let finalLot = result.updatedLot;
      if (result.priceChanged || result.leaderChanged) {
        const newDeadline = new Date(Date.now() + settings.resetOnBidSeconds * 1000);
        // Only extend deadline, never shorten it
        if (newDeadline > finalLot.bidDeadline) {
          await client.query(
            'UPDATE auction_lots SET bid_deadline = $1, updated_at = NOW() WHERE id = $2',
            [newDeadline, lotId]
          );
          finalLot = { ...finalLot, bidDeadline: newDeadline };
        }
      }

      await client.query('COMMIT');

      // Emit lot updated event - convert to snake_case for frontend consistency
      const socket = tryGetSocketService();
      socket?.emitAuctionLotUpdated(draftId, { lot: auctionLotToResponse(finalLot) });

      // Get proxy bid for response
      const proxyBidResult = await this.lotRepo.getProxyBid(lotId, roster.id);

      // Handle outbid notifications
      const userOutbidNotifications: Array<{ userId: string; lotId: number; playerId: number }> = [];
      for (const notification of result.outbidNotifications) {
        const outbidRoster = await this.rosterRepo.findById(notification.rosterId);
        if (outbidRoster && outbidRoster.userId) {
          userOutbidNotifications.push({
            userId: outbidRoster.userId,
            lotId: notification.lotId,
            playerId: lot.playerId,
          });
          socket?.emitAuctionOutbid(outbidRoster.userId, {
            lotId: notification.lotId,
            playerId: lot.playerId,
            newPrice: finalLot.currentBid,
          });
        }
      }

      return {
        proxyBid: proxyBidResult!,
        lot: finalLot,
        outbidNotifications: userOutbidNotifications,
        message: `Max bid set to $${maxBid}`,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Advance to the next nominator after a lot is settled
   */
  async advanceNominator(draftId: number): Promise<void> {
    const draft = await this.draftRepo.findById(draftId);
    if (!draft) {
      throw new NotFoundException('Draft not found');
    }

    const settings = this.getSettings(draft);
    if (settings.auctionMode !== 'fast') {
      return; // Not a fast auction, nothing to do
    }

    // Get draft order
    const order = await this.orderService.getDraftOrder(draft.leagueId, draftId, draft.createdAt.toString());
    if (order.length === 0) {
      return;
    }

    // Calculate next nominator
    const nextPick = (draft.currentPick || 0) + 1;
    const nextIndex = (nextPick - 1) % order.length;
    const nextNominator = order[nextIndex];

    // Update draft
    await this.draftRepo.update(draftId, {
      currentPick: nextPick,
      currentRosterId: nextNominator.rosterId,
    });

    // Emit nominator changed event
    const socket = tryGetSocketService();
    socket?.emitAuctionNominatorChanged(draftId, {
      nominatorRosterId: nextNominator.rosterId,
      nominationNumber: nextPick,
    });
  }

  /**
   * Get current fast auction state
   */
  async getState(draftId: number): Promise<FastAuctionState> {
    const draft = await this.draftRepo.findById(draftId);
    if (!draft) {
      throw new NotFoundException('Draft not found');
    }

    const activeLots = await this.lotRepo.findActiveLotsByDraft(draftId);
    const budgets = await this.getAllBudgets(draft);

    return {
      auctionMode: 'fast',
      activeLot: activeLots.length > 0 ? activeLots[0] : null,
      currentNominatorRosterId: draft.currentRosterId!,
      nominationNumber: draft.currentPick || 1,
      budgets: budgets.map(b => ({
        rosterId: b.rosterId,
        spent: b.spent,
        remaining: b.available,
      })),
    };
  }

  /**
   * Get budget info for all rosters in a draft
   * (Moved from SlowAuctionService to eliminate service-to-service dependency)
   */
  private async getAllBudgets(draft: Draft): Promise<{
    rosterId: number;
    totalBudget: number;
    spent: number;
    leadingCommitment: number;
    available: number;
    wonCount: number;
  }[]> {
    const league = await this.leagueRepo.findById(draft.leagueId);
    if (!league) throw new NotFoundException('League not found');

    const totalBudget = league.leagueSettings?.auctionBudget ?? 200;
    const rosterSlots = league.leagueSettings?.rosterSlots ?? 15;
    const settings = this.getSettings(draft);

    const rosters = await this.rosterRepo.findByLeagueId(draft.leagueId);
    const rosterIds = rosters.map(r => r.id);

    // Get all budget data in a single batch query
    const budgetDataMap = await this.lotRepo.getAllRosterBudgetData(draft.id, rosterIds);

    return rosters.map((roster) => {
      const budgetData = budgetDataMap.get(roster.id) ?? { spent: 0, wonCount: 0, leadingCommitment: 0 };
      const remainingSlots = rosterSlots - budgetData.wonCount;
      const reservedForMinBids = Math.max(0, remainingSlots - 1) * settings.minBid;
      const available = totalBudget - budgetData.spent - reservedForMinBids - budgetData.leadingCommitment;

      return {
        rosterId: roster.id,
        totalBudget,
        spent: budgetData.spent,
        leadingCommitment: budgetData.leadingCommitment,
        available: Math.max(0, available),
        wonCount: budgetData.wonCount,
      };
    });
  }
}
