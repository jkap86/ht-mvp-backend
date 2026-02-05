import { Pool } from 'pg';
import { AuctionLotRepository } from './auction-lot.repository';
import {
  AuctionLot,
  AuctionProxyBid,
  SlowAuctionSettings,
  auctionLotFromDatabase,
} from './auction.models';
import { DraftRepository } from '../drafts.repository';
import { Draft } from '../drafts.model';
import { RosterRepository, LeagueRepository } from '../../leagues/leagues.repository';
import { PlayerRepository } from '../../players/players.repository';
import { ValidationException, NotFoundException } from '../../../utils/exceptions';
import { getRosterBudgetDataWithClient } from './auction-budget-calculator';
import { resolvePriceWithClient, OutbidNotification } from './auction-price-resolver';
import { getAuctionRosterLockId, getDraftLockId } from '../../../utils/locks';

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

// Re-export OutbidNotification for backwards compatibility
export { OutbidNotification } from './auction-price-resolver';

export interface SettlementResult {
  lot: AuctionLot;
  winner: { rosterId: number; amount: number } | null;
  passed: boolean;
}

/**
 * Get current date string in Eastern timezone (America/New_York).
 * Fantasy football conventions use Eastern time for day boundaries.
 */
function getEasternDateString(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
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
      maxActiveNominationsGlobal: draft.settings?.maxActiveNominationsGlobal ?? 25,
      dailyNominationLimit: draft.settings?.dailyNominationLimit ?? undefined,
      minBid: draft.settings?.minBid ?? 1,
      minIncrement: draft.settings?.minIncrement ?? 1,
      auctionMode: draft.settings?.auctionMode ?? 'slow',
    };
  }

  // Get draft by ID
  async getDraft(draftId: number): Promise<Draft> {
    const draft = await this.draftRepo.findById(draftId);
    if (!draft) {
      throw new NotFoundException('Draft not found');
    }
    return draft;
  }

  // Get active lots for a draft
  async getActiveLots(draftId: number): Promise<AuctionLot[]> {
    return this.lotRepo.findActiveLotsByDraft(draftId);
  }

  // Get active lots with user's max bids included
  async getActiveLotsWithUserBids(
    draftId: number,
    rosterId: number
  ): Promise<Array<AuctionLot & { myMaxBid?: number }>> {
    const lots = await this.lotRepo.findActiveLotsByDraft(draftId);
    if (lots.length === 0) return [];

    const lotIds = lots.map((l) => l.id);
    const userBids = await this.lotRepo.getProxyBidsForRoster(lotIds, rosterId);

    return lots.map((lot) => ({
      ...lot,
      myMaxBid: userBids.get(lot.id),
    }));
  }

  // Get lots for a draft with optional status filter
  async getLotsByStatus(draftId: number, status?: string): Promise<AuctionLot[]> {
    return this.lotRepo.findLotsByDraft(draftId, status);
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
  async getAllBudgets(draftId: number): Promise<
    {
      rosterId: number;
      username: string;
      totalBudget: number;
      spent: number;
      leadingCommitment: number;
      available: number;
      wonCount: number;
    }[]
  > {
    const draft = await this.draftRepo.findById(draftId);
    if (!draft) throw new NotFoundException('Draft not found');

    const league = await this.leagueRepo.findById(draft.leagueId);
    if (!league) throw new NotFoundException('League not found');

    const totalBudget = league.leagueSettings?.auctionBudget ?? 200;
    const rosterSlots = league.leagueSettings?.rosterSlots ?? 15;
    const settings = this.getSettings(draft);

    const rosters = await this.rosterRepo.findByLeagueId(draft.leagueId);
    const rosterIds = rosters.map((r) => r.id);

    // Batch query all budget data in a single database call (avoids N+1)
    const budgetDataMap = await this.lotRepo.getAllRosterBudgetData(draftId, rosterIds);

    const budgets = rosters.map((roster) => {
      const budgetData = budgetDataMap.get(roster.id) || {
        spent: 0,
        wonCount: 0,
        leadingCommitment: 0,
      };
      const remainingSlots = rosterSlots - budgetData.wonCount;
      const reservedForMinBids = Math.max(0, remainingSlots - 1) * settings.minBid;
      const available =
        totalBudget - budgetData.spent - reservedForMinBids - budgetData.leadingCommitment;

      return {
        rosterId: roster.id,
        username: (roster as any).username || `Team ${roster.id}`,
        totalBudget,
        spent: budgetData.spent,
        leadingCommitment: budgetData.leadingCommitment,
        available: Math.max(0, available),
        wonCount: budgetData.wonCount,
      };
    });

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

  // Get nomination stats for a roster (used for UI display)
  async getNominationStats(
    draftId: number,
    rosterId: number
  ): Promise<{
    dailyNominationsUsed: number;
    dailyNominationLimit: number | null;
    dailyNominationsRemaining: number | null;
    totalActiveLots: number;
    globalActiveLimit: number;
    globalCapReached: boolean;
  }> {
    const draft = await this.draftRepo.findById(draftId);
    if (!draft) throw new NotFoundException('Draft not found');

    const settings = this.getSettings(draft);
    const today = getEasternDateString();

    // Get counts
    const dailyCount = settings.dailyNominationLimit
      ? await this.lotRepo.countDailyNominationsForRoster(draftId, rosterId, today)
      : 0;
    const totalActive = await this.lotRepo.countAllActiveLots(draftId);

    return {
      dailyNominationsUsed: dailyCount,
      dailyNominationLimit: settings.dailyNominationLimit ?? null,
      dailyNominationsRemaining: settings.dailyNominationLimit
        ? Math.max(0, settings.dailyNominationLimit - dailyCount)
        : null,
      totalActiveLots: totalActive,
      globalActiveLimit: settings.maxActiveNominationsGlobal ?? 25,
      globalCapReached: totalActive >= (settings.maxActiveNominationsGlobal ?? 25),
    };
  }

  // NOMINATE: Create a new lot for a player
  async nominate(draftId: number, rosterId: number, playerId: number): Promise<NominationResult> {
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

    // 5. Check per-team nomination limit
    const settings = this.getSettings(draft);
    const activeCount = await this.lotRepo.countActiveLotsForRoster(draftId, rosterId);
    if (activeCount >= settings.maxActiveNominationsPerTeam) {
      throw new ValidationException(
        `Maximum of ${settings.maxActiveNominationsPerTeam} active nominations allowed per team`
      );
    }

    // 5b. Check global nomination cap (league-wide limit)
    if (settings.maxActiveNominationsGlobal) {
      const totalActive = await this.lotRepo.countAllActiveLots(draftId);
      if (totalActive >= settings.maxActiveNominationsGlobal) {
        throw new ValidationException(
          `Maximum of ${settings.maxActiveNominationsGlobal} active auctions allowed league-wide`
        );
      }
    }

    // 5c. Check daily nomination limit (if configured)
    if (settings.dailyNominationLimit) {
      const today = getEasternDateString();
      const todayCount = await this.lotRepo.countDailyNominationsForRoster(draftId, rosterId, today);
      if (todayCount >= settings.dailyNominationLimit) {
        throw new ValidationException(
          `Daily nomination limit of ${settings.dailyNominationLimit} reached. Try again tomorrow.`
        );
      }
    }

    // 6. Check player not already nominated (active or won lot)
    const existing = await this.lotRepo.findLotByDraftAndPlayer(draftId, playerId);
    if (existing) {
      throw new ValidationException('Player has already been nominated in this draft');
    }

    // 7. Create lot with deadline
    // Wrap in try/catch to handle race condition with unique constraint
    const bidDeadline = new Date(Date.now() + settings.bidWindowSeconds * 1000);
    try {
      const lot = await this.lotRepo.createLot(
        draftId,
        playerId,
        rosterId,
        bidDeadline,
        settings.minBid
      );
      return { lot, message: 'Player nominated successfully' };
    } catch (error: any) {
      // Handle unique constraint violation from partial index on (draft_id, player_id)
      // This happens if two users try to nominate the same player concurrently
      if (error.code === '23505') {
        throw new ValidationException('Player has already been nominated in this draft');
      }
      throw error;
    }
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
      // Use centralized lock ID for consistency with fast auction
      await client.query('SELECT pg_advisory_xact_lock($1)', [getAuctionRosterLockId(rosterId)]);

      // 1. Lock the lot row and validate it exists and is active
      const lotResult = await client.query('SELECT * FROM auction_lots WHERE id = $1 FOR UPDATE', [
        lotId,
      ]);
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
      const budgetData = await getRosterBudgetDataWithClient(client, draftId, rosterId);
      const remainingSlots = rosterSlots - budgetData.wonCount - 1;
      const reservedForMinBids = Math.max(0, remainingSlots) * settings.minBid;

      // 4a. Worst-case check: if you win at maxBid, you must still fill remaining roster
      const worstCaseIfWin = maxBid + budgetData.spent + remainingSlots * settings.minBid;
      if (worstCaseIfWin > totalBudget) {
        const maxSafeBid = totalBudget - budgetData.spent - remainingSlots * settings.minBid;
        await client.query('ROLLBACK');
        throw new ValidationException(
          `Maximum safe bid is $${Math.max(settings.minBid, maxSafeBid)} (must reserve for remaining roster)`
        );
      }

      // 4b. Affordable check based on current commitments
      let maxAffordable =
        totalBudget - budgetData.spent - reservedForMinBids - budgetData.leadingCommitment;
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

      // 5b. Always record bid history on every proxy submission
      // This ensures users see their bid activity even if it doesn't change the visible price
      await client.query(
        `INSERT INTO auction_bid_history (lot_id, roster_id, bid_amount, is_proxy)
         VALUES ($1, $2, $3, $4)`,
        [lotId, rosterId, maxBid, true]
      );

      // 6. Resolve price within transaction (don't pass deadline - we'll handle timer reset)
      const result = await resolvePriceWithClient(client, lot, settings);

      // For slow auction, reset timer only on leader change
      let finalLot = result.updatedLot;
      if (result.leaderChanged) {
        const newBidDeadline = new Date(Date.now() + settings.bidWindowSeconds * 1000);
        await client.query(
          'UPDATE auction_lots SET bid_deadline = $1, updated_at = NOW() WHERE id = $2',
          [newBidDeadline, lot.id]
        );
        finalLot = { ...finalLot, bidDeadline: newBidDeadline };
      }

      await client.query('COMMIT');

      return {
        proxyBid,
        lot: finalLot,
        outbidNotifications: result.outbidNotifications,
        message: 'Max bid set successfully',
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Resolve price based on proxy bids (second-price auction) - non-transactional version
  // NOTE: This method is DEPRECATED. Prefer using resolvePriceWithClient in a transaction
  // for better concurrency safety.
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
      // bid_count tracks price changes only (not just leader changes)
      const priceChanged = newPrice !== lot.currentBid;
      const updates: Partial<AuctionLot> = {
        currentBidderRosterId: newLeader,
        currentBid: newPrice,
        bidCount: priceChanged ? lot.bidCount + 1 : lot.bidCount,
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

      // Use CAS-style update to prevent race conditions
      // If the lot's current_bid changed since we read it, this will throw
      updatedLot = await this.lotRepo.updateLot(lot.id, updates, lot.currentBid);

      // Record bid history
      await this.lotRepo.recordBidHistory(lot.id, newLeader, newPrice, true);
    }

    return { updatedLot, outbidNotifications };
  }

  // Settle an expired lot (transaction-safe with draft pick creation)
  // Now includes fallback logic: if the highest bidder can't afford,
  // try the next highest bidder until one can afford, or pass the lot.
  async settleLot(lotId: number): Promise<SettlementResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Lock and get lot
      const lotResult = await client.query('SELECT * FROM auction_lots WHERE id = $1 FOR UPDATE', [
        lotId,
      ]);
      if (lotResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFoundException('Lot not found');
      }
      const lot = auctionLotFromDatabase(lotResult.rows[0]);

      if (lot.status !== 'active') {
        await client.query('ROLLBACK');
        throw new ValidationException('Lot is not active');
      }

      // Get all proxy bids for fallback logic, ordered by max_bid DESC
      const proxyBidsResult = await client.query(
        `SELECT * FROM auction_proxy_bids
         WHERE lot_id = $1
         ORDER BY max_bid DESC, created_at ASC`,
        [lotId]
      );
      const proxyBids = proxyBidsResult.rows;

      // If no bids, pass the lot
      if (proxyBids.length === 0) {
        const passResult = await client.query(
          `UPDATE auction_lots
           SET status = 'passed', updated_at = CURRENT_TIMESTAMP
           WHERE id = $1
           RETURNING *`,
          [lotId]
        );
        const passedLot = auctionLotFromDatabase(passResult.rows[0]);
        await client.query('COMMIT');
        return { lot: passedLot, winner: null, passed: true };
      }

      // Load draft and league data once
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

      // Acquire draft-level lock first (per lock ordering: DRAFT before ROSTER)
      await client.query('SELECT pg_advisory_xact_lock($1)', [getDraftLockId(lot.draftId)]);

      // Try each bidder in order until one can afford
      for (let i = 0; i < proxyBids.length; i++) {
        const candidateRosterId = proxyBids[i].roster_id;
        const candidateMaxBid = proxyBids[i].max_bid;

        // Calculate second-price auction price for this candidate
        let price: number;
        if (i === proxyBids.length - 1) {
          // Last bidder (or only bidder) - price is minBid
          price = settings.minBid;
        } else {
          // Price is next highest bid + increment, capped at candidate's max
          const nextHighestBid = proxyBids[i + 1].max_bid;
          price = Math.min(candidateMaxBid, nextHighestBid + settings.minIncrement);
        }

        // Lock candidate's roster (after DRAFT lock per ordering)
        await client.query('SELECT pg_advisory_xact_lock($1)', [
          getAuctionRosterLockId(candidateRosterId),
        ]);

        // Validate budget and slots
        const budgetData = await getRosterBudgetDataWithClient(client, lot.draftId, candidateRosterId);

        // Check roster not full
        if (budgetData.wonCount >= rosterSlots) {
          console.warn(
            `Lot ${lotId}: Bidder ${candidateRosterId} roster is full (${budgetData.wonCount}/${rosterSlots}), trying next bidder`
          );
          continue;
        }

        // Check budget: spent + price + reserve for remaining slots <= total
        const remainingAfterWin = rosterSlots - budgetData.wonCount - 1;
        const requiredReserve = remainingAfterWin * settings.minBid;
        if (budgetData.spent + price + requiredReserve > totalBudget) {
          console.warn(
            `Lot ${lotId}: Bidder ${candidateRosterId} cannot afford $${price} (spent: $${budgetData.spent}, reserve: $${requiredReserve}), trying next bidder`
          );
          continue;
        }

        // This bidder can afford - settle to them
        const settleResult = await client.query(
          `UPDATE auction_lots
           SET status = 'won', winning_roster_id = $2, winning_bid = $3,
               current_bidder_roster_id = $2, current_bid = $3, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1
           RETURNING *`,
          [lotId, candidateRosterId, price]
        );
        const settledLot = auctionLotFromDatabase(settleResult.rows[0]);

        // Create draft pick entry
        await client.query(
          `INSERT INTO draft_picks (draft_id, roster_id, player_id, pick_number, round, pick_in_round)
           VALUES ($1, $2, $3,
             (SELECT COALESCE(MAX(pick_number), 0) + 1 FROM draft_picks WHERE draft_id = $1),
             1,
             (SELECT COALESCE(MAX(pick_number), 0) + 1 FROM draft_picks WHERE draft_id = $1))`,
          [lot.draftId, candidateRosterId, lot.playerId]
        );

        // Remove the player from all draft queues
        await client.query('DELETE FROM draft_queue WHERE draft_id = $1 AND player_id = $2', [
          lot.draftId,
          lot.playerId,
        ]);

        await client.query('COMMIT');

        return {
          lot: settledLot,
          winner: { rosterId: candidateRosterId, amount: price },
          passed: false,
        };
      }

      // No bidder could afford - pass the lot
      console.warn(`Lot ${lotId}: No bidder could afford the lot, marking as passed`);
      const passResult = await client.query(
        `UPDATE auction_lots
         SET status = 'passed', updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
        [lotId]
      );
      const passedLot = auctionLotFromDatabase(passResult.rows[0]);
      await client.query('COMMIT');

      return { lot: passedLot, winner: null, passed: true };
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

  // Get bid history for a lot with usernames
  async getBidHistoryWithUsernames(
    draftId: number,
    lotId: number
  ): Promise<Array<{ id: number; lotId: number; rosterId: number; bidAmount: number; isProxy: boolean; createdAt: Date; username?: string }>> {
    // Get the lot to verify it belongs to this draft
    const lot = await this.lotRepo.findLotById(lotId);
    if (!lot || lot.draftId !== draftId) {
      throw new NotFoundException('Lot not found');
    }

    // Get draft to access league
    const draft = await this.draftRepo.findById(draftId);
    if (!draft) {
      throw new NotFoundException('Draft not found');
    }

    // Get bid history
    const history = await this.lotRepo.getBidHistoryForLot(lotId);

    // Get rosters for username lookup
    const rosters = await this.rosterRepo.findByLeagueId(draft.leagueId);
    const rosterMap = new Map(rosters.map((r) => [r.id, (r as any).username || `Team ${r.id}`]));

    // Combine history with usernames
    return history.map((entry) => ({
      ...entry,
      username: rosterMap.get(entry.rosterId),
    }));
  }
}
