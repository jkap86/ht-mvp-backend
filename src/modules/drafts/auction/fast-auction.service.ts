import { PoolClient } from 'pg';
import { AuctionLotRepository } from './auction-lot.repository';
import { DraftRepository } from '../drafts.repository';
import { RosterRepository, LeagueRepository } from '../../leagues/leagues.repository';
import { DraftOrderService } from '../draft-order.service';
import { SlowAuctionService } from './slow-auction.service';
import { getSocketService } from '../../../socket/socket.service';
import { PlayerRepository } from '../../players/players.repository';
import { AuctionLot, AuctionProxyBid, auctionLotFromDatabase, auctionLotToResponse } from './auction.models';
import { ValidationException, NotFoundException, ForbiddenException } from '../../../utils/exceptions';
import { pool } from '../../../db/pool';
import { Draft } from '../drafts.model';

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
    private readonly slowAuctionService: SlowAuctionService,
    private readonly playerRepo: PlayerRepository
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
    const socket = getSocketService();
    socket.emitAuctionLotCreated(draftId, { lot: auctionLotToResponse(lot) });

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
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Acquire roster-level lock to prevent cross-lot race conditions
      const roster = await this.rosterRepo.findByLeagueAndUser(draft.leagueId, userId);
      if (!roster) {
        throw new ForbiddenException('You are not a member of this league');
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), $2)', ['auction_roster', roster.id]);

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
      const budgetInfo = await this.getRosterBudgetDataWithClient(client, draftId, roster.id);

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

      // Resolve price
      const oldPrice = lot.currentBid;
      const oldLeader = lot.currentBidderRosterId;

      const { updatedLot, outbidNotifications } = await this.resolvePriceWithClient(client, lot, settings);

      // Fast auction specific: reset timer on price/leader change
      const priceChanged = updatedLot.currentBid > oldPrice;
      const leaderChanged = updatedLot.currentBidderRosterId !== oldLeader;

      if (priceChanged || leaderChanged) {
        const newDeadline = new Date(Date.now() + settings.resetOnBidSeconds * 1000);
        // Only extend deadline, never shorten it
        if (newDeadline > updatedLot.bidDeadline) {
          await client.query(
            'UPDATE auction_lots SET bid_deadline = $1, updated_at = NOW() WHERE id = $2',
            [newDeadline, lotId]
          );
          updatedLot.bidDeadline = newDeadline;
        }
      }

      await client.query('COMMIT');

      // Emit lot updated event - convert to snake_case for frontend consistency
      const socket = getSocketService();
      socket.emitAuctionLotUpdated(draftId, { lot: auctionLotToResponse(updatedLot) });

      // Get proxy bid for response
      const proxyBidResult = await this.lotRepo.getProxyBid(lotId, roster.id);

      // Handle outbid notifications
      const userOutbidNotifications: Array<{ userId: string; lotId: number; playerId: number }> = [];
      for (const notification of outbidNotifications) {
        const outbidRoster = await this.rosterRepo.findById(notification.rosterId);
        if (outbidRoster && outbidRoster.userId) {
          userOutbidNotifications.push({
            userId: outbidRoster.userId,
            lotId: notification.lotId,
            playerId: lot.playerId,
          });
          socket.emitAuctionOutbid(outbidRoster.userId, {
            lotId: notification.lotId,
            playerId: lot.playerId,
            newPrice: updatedLot.currentBid,
          });
        }
      }

      return {
        proxyBid: proxyBidResult!,
        lot: updatedLot,
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
   * Helper: Get roster budget data using a specific client (for transactions)
   */
  private async getRosterBudgetDataWithClient(
    client: PoolClient,
    draftId: number,
    rosterId: number
  ): Promise<{ spent: number; wonCount: number; leadingCommitment: number }> {
    const wonResult = await client.query(
      `SELECT COALESCE(SUM(winning_bid), 0) as spent, COUNT(*) as won_count
       FROM auction_lots
       WHERE draft_id = $1 AND winning_roster_id = $2 AND status = 'won'`,
      [draftId, rosterId]
    );
    const leadingResult = await client.query(
      `SELECT COALESCE(SUM(current_bid), 0) as leading_commitment
       FROM auction_lots
       WHERE draft_id = $1 AND current_bidder_roster_id = $2 AND status = 'active'`,
      [draftId, rosterId]
    );
    return {
      spent: parseInt(wonResult.rows[0].spent, 10),
      wonCount: parseInt(wonResult.rows[0].won_count, 10),
      leadingCommitment: parseInt(leadingResult.rows[0].leading_commitment, 10),
    };
  }

  /**
   * Helper: Resolve price using a specific client (for transactions)
   * Based on SlowAuctionService.resolvePriceWithClient but adapted for fast auction
   */
  private async resolvePriceWithClient(
    client: PoolClient,
    lot: AuctionLot,
    settings: FastAuctionSettings
  ): Promise<{ updatedLot: AuctionLot; outbidNotifications: Array<{ rosterId: number; lotId: number; previousBid: number; newLeadingBid: number }> }> {
    const proxyBidsResult = await client.query(
      `SELECT * FROM auction_proxy_bids
       WHERE lot_id = $1
       ORDER BY max_bid DESC, updated_at ASC`,
      [lot.id]
    );
    const proxyBids: AuctionProxyBid[] = proxyBidsResult.rows.map(row => ({
      id: row.id,
      lotId: row.lot_id,
      rosterId: row.roster_id,
      maxBid: row.max_bid,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    const outbidNotifications: Array<{ rosterId: number; lotId: number; previousBid: number; newLeadingBid: number }> = [];
    let updatedLot = lot;

    if (proxyBids.length === 0) {
      return { updatedLot, outbidNotifications };
    }

    const previousLeader = lot.currentBidderRosterId;
    let newLeader: number;
    let newPrice: number;

    if (proxyBids.length === 1) {
      newLeader = proxyBids[0].rosterId;
      newPrice = settings.minBid;
    } else {
      const highest = proxyBids[0];
      const secondHighest = proxyBids[1];
      newLeader = highest.rosterId;
      newPrice = Math.min(highest.maxBid, secondHighest.maxBid + settings.minIncrement);
    }

    const leaderChanged = newLeader !== previousLeader;

    if (leaderChanged || newPrice !== lot.currentBid) {
      // For fast auction, we don't reset the timer here - that's handled by the caller
      let newBidDeadline = lot.bidDeadline;

      if (leaderChanged && previousLeader) {
        outbidNotifications.push({
          rosterId: previousLeader,
          lotId: lot.id,
          previousBid: lot.currentBid,
          newLeadingBid: newPrice,
        });
      }

      // bid_count tracks price changes only (not just leader changes)
      const priceChanged = newPrice !== lot.currentBid;
      const newBidCount = priceChanged ? lot.bidCount + 1 : lot.bidCount;

      const updateResult = await client.query(
        `UPDATE auction_lots
         SET current_bidder_roster_id = $2, current_bid = $3, bid_count = $4, bid_deadline = $5, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
        [lot.id, newLeader, newPrice, newBidCount, newBidDeadline]
      );
      updatedLot = auctionLotFromDatabase(updateResult.rows[0]);

      // Record bid history
      await client.query(
        `INSERT INTO auction_bid_history (lot_id, roster_id, bid_amount, is_proxy)
         VALUES ($1, $2, $3, $4)`,
        [lot.id, newLeader, newPrice, true]
      );
    }

    return { updatedLot, outbidNotifications };
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
    const socket = getSocketService();
    socket.emitAuctionNominatorChanged(draftId, {
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
    const budgets = await this.slowAuctionService.getAllBudgets(draftId);

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
}
