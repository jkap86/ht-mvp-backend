import { Pool, PoolClient } from 'pg';
import { AuctionLotRepository } from './auction-lot.repository';
import { AuctionLot, AuctionProxyBid, SlowAuctionSettings, auctionLotFromDatabase } from './auction.models';
import { DraftRepository } from '../drafts.repository';
import { Draft } from '../drafts.model';
import { RosterRepository, LeagueRepository } from '../../leagues/leagues.repository';
import { PlayerRepository } from '../../players/players.repository';
import { ValidationException, ForbiddenException, NotFoundException } from '../../../utils/exceptions';

export interface NominationResult {
  lot: AuctionLot;
  message: string;
}

export interface SetMaxBidResult {
  proxyBid: AuctionProxyBid;
  lot: AuctionLot;
  outbidNotifications: OutbidNotification[];
  message: string;
}

export interface OutbidNotification {
  rosterId: number;
  lotId: number;
  previousBid: number;
  newLeadingBid: number;
}

export interface SettlementResult {
  lot: AuctionLot;
  winner: { rosterId: number; amount: number } | null;
  passed: boolean;
}

export class SlowAuctionService {
  constructor(
    private readonly lotRepo: AuctionLotRepository,
    private readonly draftRepo: DraftRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly playerRepo: PlayerRepository,
    private readonly pool: Pool
  ) {}

  // Get auction settings with defaults
  getSettings(draft: Draft): SlowAuctionSettings {
    return {
      bidWindowSeconds: draft.settings?.bidWindowSeconds ?? 43200,
      maxActiveNominationsPerTeam: draft.settings?.maxActiveNominationsPerTeam ?? 2,
      minBid: draft.settings?.minBid ?? 1,
      minIncrement: draft.settings?.minIncrement ?? 1,
    };
  }

  // Get active lots for a draft
  async getActiveLots(draftId: number): Promise<AuctionLot[]> {
    return this.lotRepo.findActiveLotsByDraft(draftId);
  }

  // Get a single lot by ID (validates it belongs to the draft)
  async getLotById(draftId: number, lotId: number): Promise<AuctionLot> {
    const lot = await this.lotRepo.findLotById(lotId);
    if (!lot) {
      throw new NotFoundException('Lot not found');
    }
    if (lot.draftId !== draftId) {
      throw new NotFoundException('Lot not found in this draft');
    }
    return lot;
  }

  // Get user's proxy bid for a lot
  async getUserProxyBid(lotId: number, rosterId: number): Promise<AuctionProxyBid | null> {
    return this.lotRepo.getProxyBid(lotId, rosterId);
  }

  // Get budget info for all rosters in a draft
  async getAllBudgets(
    draftId: number
  ): Promise<{
    rosterId: number;
    username: string;
    totalBudget: number;
    spent: number;
    leadingCommitment: number;
    available: number;
    wonCount: number;
  }[]> {
    const draft = await this.draftRepo.findById(draftId);
    if (!draft) throw new NotFoundException('Draft not found');

    const league = await this.leagueRepo.findById(draft.leagueId);
    if (!league) throw new NotFoundException('League not found');

    const totalBudget = league.leagueSettings?.auctionBudget ?? 200;
    const rosterSlots = league.leagueSettings?.rosterSlots ?? 15;
    const settings = this.getSettings(draft);

    const rosters = await this.rosterRepo.findByLeagueId(draft.leagueId);
    const budgets = await Promise.all(
      rosters.map(async (roster) => {
        const budgetData = await this.lotRepo.getRosterBudgetData(draftId, roster.id);
        const remainingSlots = rosterSlots - budgetData.wonCount;
        const reservedForMinBids = Math.max(0, remainingSlots - 1) * settings.minBid;
        const available = totalBudget - budgetData.spent - reservedForMinBids - budgetData.leadingCommitment;

        return {
          rosterId: roster.id,
          username: (roster as any).username || `Team ${roster.id}`,
          totalBudget,
          spent: budgetData.spent,
          leadingCommitment: budgetData.leadingCommitment,
          available: Math.max(0, available),
          wonCount: budgetData.wonCount,
        };
      })
    );

    return budgets;
  }

  // Budget calculation
  async getMaxAffordableBid(
    draftId: number,
    rosterId: number,
    totalBudget: number,
    rosterSlots: number,
    minBid: number = 1
  ): Promise<number> {
    const budgetData = await this.lotRepo.getRosterBudgetData(draftId, rosterId);
    const remainingSlots = rosterSlots - budgetData.wonCount - 1; // -1 for current
    const reservedForMinBids = Math.max(0, remainingSlots) * minBid;
    return totalBudget - budgetData.spent - reservedForMinBids - budgetData.leadingCommitment;
  }

  // NOMINATE: Create a new lot for a player
  async nominate(
    draftId: number,
    rosterId: number,
    playerId: number
  ): Promise<NominationResult> {
    // 1. Validate draft exists, is auction, and in_progress
    const draft = await this.draftRepo.findById(draftId);
    if (!draft) throw new NotFoundException('Draft not found');
    if (draft.status !== 'in_progress') {
      throw new ValidationException('Draft is not in progress');
    }
    if (draft.draftType !== 'auction') {
      throw new ValidationException('This is not an auction draft');
    }

    // 2. Validate player exists
    const player = await this.playerRepo.findById(playerId);
    if (!player) {
      throw new ValidationException('Player not found');
    }

    // 3. Check player not already drafted (in draft_picks table)
    const isAlreadyDrafted = await this.draftRepo.isPlayerDrafted(draftId, playerId);
    if (isAlreadyDrafted) {
      throw new ValidationException('Player has already been drafted');
    }

    // 4. Check roster has remaining slots
    const league = await this.leagueRepo.findById(draft.leagueId);
    const rosterSlots = league?.leagueSettings?.rosterSlots ?? 15;
    const budgetData = await this.lotRepo.getRosterBudgetData(draftId, rosterId);
    if (budgetData.wonCount >= rosterSlots) {
      throw new ValidationException('Your roster is full');
    }

    // 5. Check nomination limit
    const settings = this.getSettings(draft);
    const activeCount = await this.lotRepo.countActiveLotsForRoster(draftId, rosterId);
    if (activeCount >= settings.maxActiveNominationsPerTeam) {
      throw new ValidationException(
        `Maximum of ${settings.maxActiveNominationsPerTeam} active nominations allowed`
      );
    }

    // 6. Check player not already nominated (active or won lot)
    const existing = await this.lotRepo.findLotByDraftAndPlayer(draftId, playerId);
    if (existing) {
      throw new ValidationException('Player has already been nominated in this draft');
    }

    // 7. Create lot with deadline
    const bidDeadline = new Date(Date.now() + settings.bidWindowSeconds * 1000);
    const lot = await this.lotRepo.createLot(
      draftId,
      playerId,
      rosterId,
      bidDeadline,
      settings.minBid
    );

    return { lot, message: 'Player nominated successfully' };
  }

  // SET_MAX_BID: Set or update proxy bid on a lot (transaction-safe)
  async setMaxBid(
    draftId: number,
    lotId: number,
    rosterId: number,
    maxBid: number
  ): Promise<SetMaxBidResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 0. Acquire roster-level lock to prevent cross-lot race conditions
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), $2)', ['auction_roster', rosterId]);

      // 1. Lock the lot row and validate it exists and is active
      const lotResult = await client.query(
        'SELECT * FROM auction_lots WHERE id = $1 FOR UPDATE',
        [lotId]
      );
      if (lotResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFoundException('Lot not found');
      }
      const lot = auctionLotFromDatabase(lotResult.rows[0]);

      if (lot.status !== 'active') {
        await client.query('ROLLBACK');
        throw new ValidationException('Lot is not active');
      }
      if (lot.draftId !== draftId) {
        await client.query('ROLLBACK');
        throw new ValidationException('Lot does not belong to this draft');
      }

      // 2. Get draft and league for settings/budget
      const draft = await this.draftRepo.findById(draftId);
      if (!draft) {
        await client.query('ROLLBACK');
        throw new NotFoundException('Draft not found');
      }
      const league = await this.leagueRepo.findById(draft.leagueId);
      if (!league) {
        await client.query('ROLLBACK');
        throw new NotFoundException('League not found');
      }

      const settings = this.getSettings(draft);
      const totalBudget = league.leagueSettings?.auctionBudget ?? 200;
      const rosterSlots = league.leagueSettings?.rosterSlots ?? 15;

      // 3. Validate min bid
      if (maxBid < settings.minBid) {
        await client.query('ROLLBACK');
        throw new ValidationException(`Minimum bid is $${settings.minBid}`);
      }

      // 4. Budget validation within transaction (exclude current lot if already leading)
      const budgetData = await this.getRosterBudgetDataWithClient(client, draftId, rosterId);
      const remainingSlots = rosterSlots - budgetData.wonCount - 1;
      const reservedForMinBids = Math.max(0, remainingSlots) * settings.minBid;

      // 4a. Worst-case check: if you win at maxBid, you must still fill remaining roster
      const worstCaseIfWin = maxBid + budgetData.spent + (remainingSlots * settings.minBid);
      if (worstCaseIfWin > totalBudget) {
        const maxSafeBid = totalBudget - budgetData.spent - (remainingSlots * settings.minBid);
        await client.query('ROLLBACK');
        throw new ValidationException(`Maximum safe bid is $${Math.max(settings.minBid, maxSafeBid)} (must reserve for remaining roster)`);
      }

      // 4b. Affordable check based on current commitments
      let maxAffordable = totalBudget - budgetData.spent - reservedForMinBids - budgetData.leadingCommitment;
      const isLeadingThisLot = lot.currentBidderRosterId === rosterId;
      if (isLeadingThisLot) {
        maxAffordable += lot.currentBid; // Can reuse current commitment
      }
      if (maxBid > maxAffordable) {
        await client.query('ROLLBACK');
        throw new ValidationException(`Maximum affordable bid is $${maxAffordable}`);
      }

      // 5. Upsert proxy bid within transaction
      const proxyBidResult = await client.query(
        `INSERT INTO auction_proxy_bids (lot_id, roster_id, max_bid)
         VALUES ($1, $2, $3)
         ON CONFLICT (lot_id, roster_id)
         DO UPDATE SET max_bid = EXCLUDED.max_bid, updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [lotId, rosterId, maxBid]
      );
      const proxyBid: AuctionProxyBid = {
        id: proxyBidResult.rows[0].id,
        lotId: proxyBidResult.rows[0].lot_id,
        rosterId: proxyBidResult.rows[0].roster_id,
        maxBid: proxyBidResult.rows[0].max_bid,
        createdAt: proxyBidResult.rows[0].created_at,
        updatedAt: proxyBidResult.rows[0].updated_at,
      };

      // 6. Resolve price within transaction
      const { updatedLot, outbidNotifications } = await this.resolvePriceWithClient(client, lot, settings);

      await client.query('COMMIT');

      return {
        proxyBid,
        lot: updatedLot,
        outbidNotifications,
        message: 'Max bid set successfully',
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Helper: Get roster budget data using a specific client (for transactions)
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

  // Helper: Resolve price using a specific client (for transactions)
  private async resolvePriceWithClient(
    client: PoolClient,
    lot: AuctionLot,
    settings: SlowAuctionSettings
  ): Promise<{ updatedLot: AuctionLot; outbidNotifications: OutbidNotification[] }> {
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

    const outbidNotifications: OutbidNotification[] = [];
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
      let newBidDeadline = lot.bidDeadline;
      if (leaderChanged) {
        newBidDeadline = new Date(Date.now() + settings.bidWindowSeconds * 1000);
        if (previousLeader) {
          outbidNotifications.push({
            rosterId: previousLeader,
            lotId: lot.id,
            previousBid: lot.currentBid,
            newLeadingBid: newPrice,
          });
        }
      }

      const updateResult = await client.query(
        `UPDATE auction_lots
         SET current_bidder_roster_id = $2, current_bid = $3, bid_count = $4, bid_deadline = $5, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
        [lot.id, newLeader, newPrice, lot.bidCount + 1, newBidDeadline]
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

  // Resolve price based on proxy bids (second-price auction)
  async resolvePrice(
    lot: AuctionLot,
    settings: SlowAuctionSettings
  ): Promise<{ updatedLot: AuctionLot; outbidNotifications: OutbidNotification[] }> {
    const proxyBids = await this.lotRepo.getAllProxyBidsForLot(lot.id);
    const outbidNotifications: OutbidNotification[] = [];
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
      const updates: Partial<AuctionLot> = {
        currentBidderRosterId: newLeader,
        currentBid: newPrice,
        bidCount: lot.bidCount + 1,
      };

      // Reset timer only if leader changed
      if (leaderChanged) {
        updates.bidDeadline = new Date(Date.now() + settings.bidWindowSeconds * 1000);

        // Notify previous leader they were outbid
        if (previousLeader) {
          outbidNotifications.push({
            rosterId: previousLeader,
            lotId: lot.id,
            previousBid: lot.currentBid,
            newLeadingBid: newPrice,
          });
        }
      }

      updatedLot = await this.lotRepo.updateLot(lot.id, updates);

      // Record bid history
      await this.lotRepo.recordBidHistory(lot.id, newLeader, newPrice, true);
    }

    return { updatedLot, outbidNotifications };
  }

  // Settle an expired lot (transaction-safe with draft pick creation)
  async settleLot(lotId: number): Promise<SettlementResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Lock and get lot
      const lotResult = await client.query(
        'SELECT * FROM auction_lots WHERE id = $1 FOR UPDATE',
        [lotId]
      );
      if (lotResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFoundException('Lot not found');
      }
      const lot = auctionLotFromDatabase(lotResult.rows[0]);

      if (lot.status !== 'active') {
        await client.query('ROLLBACK');
        throw new ValidationException('Lot is not active');
      }

      if (lot.currentBidderRosterId) {
        // Lock winner's roster to prevent concurrent settlements
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1), $2)', ['auction_roster', lot.currentBidderRosterId]);

        // Re-validate budget and slots at settlement time
        const draft = await this.draftRepo.findById(lot.draftId);
        if (!draft) {
          await client.query('ROLLBACK');
          throw new NotFoundException('Draft not found');
        }
        const league = await this.leagueRepo.findById(draft.leagueId);
        if (!league) {
          await client.query('ROLLBACK');
          throw new NotFoundException('League not found');
        }

        const totalBudget = league.leagueSettings?.auctionBudget ?? 200;
        const rosterSlots = league.leagueSettings?.rosterSlots ?? 15;
        const settings = this.getSettings(draft);
        const budgetData = await this.getRosterBudgetDataWithClient(client, lot.draftId, lot.currentBidderRosterId);

        // Check roster not full
        if (budgetData.wonCount >= rosterSlots) {
          await client.query('ROLLBACK');
          throw new ValidationException('Winner roster is full - lot cannot settle');
        }

        // Check budget: spent + this winning bid + reserve for remaining slots <= total
        const remainingAfterWin = rosterSlots - budgetData.wonCount - 1;
        const requiredReserve = remainingAfterWin * settings.minBid;
        if (budgetData.spent + lot.currentBid + requiredReserve > totalBudget) {
          await client.query('ROLLBACK');
          throw new ValidationException('Winner cannot afford this lot after other settlements');
        }

        // Mark lot won
        const settleResult = await client.query(
          `UPDATE auction_lots
           SET status = 'won', winning_roster_id = $2, winning_bid = $3, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1
           RETURNING *`,
          [lotId, lot.currentBidderRosterId, lot.currentBid]
        );
        const settledLot = auctionLotFromDatabase(settleResult.rows[0]);

        // Create draft pick entry
        // For auctions, pick_in_round and round are less meaningful, so we use 1 for round
        // and calculate pick_number as the next sequential pick
        await client.query(
          `INSERT INTO draft_picks (draft_id, roster_id, player_id, pick_number, round, pick_in_round)
           VALUES ($1, $2, $3,
             (SELECT COALESCE(MAX(pick_number), 0) + 1 FROM draft_picks WHERE draft_id = $1),
             1,
             (SELECT COALESCE(MAX(pick_number), 0) + 1 FROM draft_picks WHERE draft_id = $1))`,
          [lot.draftId, lot.currentBidderRosterId, lot.playerId]
        );

        // Also remove the player from all draft queues in this draft
        await client.query(
          'DELETE FROM draft_queue WHERE draft_id = $1 AND player_id = $2',
          [lot.draftId, lot.playerId]
        );

        await client.query('COMMIT');

        return {
          lot: settledLot,
          winner: { rosterId: lot.currentBidderRosterId, amount: lot.currentBid },
          passed: false,
        };
      } else {
        // Mark passed
        const passResult = await client.query(
          `UPDATE auction_lots
           SET status = 'passed', updated_at = CURRENT_TIMESTAMP
           WHERE id = $1
           RETURNING *`,
          [lotId]
        );
        const passedLot = auctionLotFromDatabase(passResult.rows[0]);

        await client.query('COMMIT');

        return {
          lot: passedLot,
          winner: null,
          passed: true,
        };
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Process all expired lots (called by job)
  async processExpiredLots(): Promise<SettlementResult[]> {
    const expiredLots = await this.lotRepo.findExpiredLots();
    const results: SettlementResult[] = [];

    for (const lot of expiredLots) {
      try {
        const result = await this.settleLot(lot.id);
        results.push(result);
      } catch (error) {
        console.error(`Failed to settle lot ${lot.id}:`, error);
      }
    }

    return results;
  }
}
