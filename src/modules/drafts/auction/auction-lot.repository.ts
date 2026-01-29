import { Pool } from 'pg';
import {
  AuctionLot,
  AuctionProxyBid,
  AuctionBidHistory,
  auctionLotFromDatabase,
  auctionProxyBidFromDatabase,
  auctionBidHistoryFromDatabase,
} from './auction.models';

export interface RosterBudgetData {
  spent: number;
  wonCount: number;
  leadingCommitment: number;
}

export class AuctionLotRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Creates a new auction lot for a nominated player
   */
  async createLot(
    draftId: number,
    playerId: number,
    nominatorRosterId: number,
    bidDeadline: Date,
    startingBid: number
  ): Promise<AuctionLot> {
    const result = await this.db.query(
      `INSERT INTO auction_lots (draft_id, player_id, nominator_roster_id, bid_deadline, current_bid, status)
       VALUES ($1, $2, $3, $4, $5, 'active')
       RETURNING *`,
      [draftId, playerId, nominatorRosterId, bidDeadline, startingBid]
    );
    return auctionLotFromDatabase(result.rows[0]);
  }

  /**
   * Find a lot by its ID
   */
  async findLotById(lotId: number): Promise<AuctionLot | null> {
    const result = await this.db.query('SELECT * FROM auction_lots WHERE id = $1', [lotId]);
    return result.rows.length > 0 ? auctionLotFromDatabase(result.rows[0]) : null;
  }

  /**
   * Find all active lots for a draft
   */
  async findActiveLotsByDraft(draftId: number): Promise<AuctionLot[]> {
    const result = await this.db.query(
      `SELECT * FROM auction_lots
       WHERE draft_id = $1 AND status = 'active'
       ORDER BY bid_deadline ASC`,
      [draftId]
    );
    return result.rows.map(auctionLotFromDatabase);
  }

  /**
   * Find lots for a draft with optional status filter
   */
  async findLotsByDraft(draftId: number, status?: string): Promise<AuctionLot[]> {
    let query = `SELECT * FROM auction_lots WHERE draft_id = $1`;
    const params: any[] = [draftId];

    if (status && status !== 'all') {
      query += ` AND status = $2`;
      params.push(status);
    }

    query += ` ORDER BY id DESC`;

    const result = await this.db.query(query, params);
    return result.rows.map(auctionLotFromDatabase);
  }

  /**
   * Find a lot by draft and player (for duplicate check)
   */
  async findLotByDraftAndPlayer(draftId: number, playerId: number): Promise<AuctionLot | null> {
    const result = await this.db.query(
      `SELECT * FROM auction_lots WHERE draft_id = $1 AND player_id = $2 AND status IN ('active', 'won')`,
      [draftId, playerId]
    );
    return result.rows.length > 0 ? auctionLotFromDatabase(result.rows[0]) : null;
  }

  /**
   * Count active lots for a specific roster (nominator)
   */
  async countActiveLotsForRoster(draftId: number, rosterId: number): Promise<number> {
    const result = await this.db.query(
      `SELECT COUNT(*) as count FROM auction_lots
       WHERE draft_id = $1 AND nominator_roster_id = $2 AND status = 'active'`,
      [draftId, rosterId]
    );
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Generic update for a lot
   */
  async updateLot(lotId: number, updates: Partial<AuctionLot>): Promise<AuctionLot> {
    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.currentBid !== undefined) {
      setClauses.push(`current_bid = $${paramIndex++}`);
      values.push(updates.currentBid);
    }
    if (updates.currentBidderRosterId !== undefined) {
      setClauses.push(`current_bidder_roster_id = $${paramIndex++}`);
      values.push(updates.currentBidderRosterId);
    }
    if (updates.bidCount !== undefined) {
      setClauses.push(`bid_count = $${paramIndex++}`);
      values.push(updates.bidCount);
    }
    if (updates.bidDeadline !== undefined) {
      setClauses.push(`bid_deadline = $${paramIndex++}`);
      values.push(updates.bidDeadline);
    }
    if (updates.status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`);
      values.push(updates.status);
    }
    if (updates.winningRosterId !== undefined) {
      setClauses.push(`winning_roster_id = $${paramIndex++}`);
      values.push(updates.winningRosterId);
    }
    if (updates.winningBid !== undefined) {
      setClauses.push(`winning_bid = $${paramIndex++}`);
      values.push(updates.winningBid);
    }

    if (setClauses.length === 0) {
      const existing = await this.findLotById(lotId);
      if (!existing) throw new Error('Auction lot not found');
      return existing;
    }

    values.push(lotId);
    const result = await this.db.query(
      `UPDATE auction_lots SET ${setClauses.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $${paramIndex}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      throw new Error('Auction lot not found');
    }

    return auctionLotFromDatabase(result.rows[0]);
  }

  /**
   * Settle a lot with a winner
   */
  async settleLot(lotId: number, winningRosterId: number, winningBid: number): Promise<AuctionLot> {
    const result = await this.db.query(
      `UPDATE auction_lots
       SET status = 'won', winning_roster_id = $2, winning_bid = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [lotId, winningRosterId, winningBid]
    );

    if (result.rows.length === 0) {
      throw new Error('Auction lot not found');
    }

    return auctionLotFromDatabase(result.rows[0]);
  }

  /**
   * Mark a lot as passed (no winner)
   */
  async passLot(lotId: number): Promise<AuctionLot> {
    const result = await this.db.query(
      `UPDATE auction_lots
       SET status = 'passed', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [lotId]
    );

    if (result.rows.length === 0) {
      throw new Error('Auction lot not found');
    }

    return auctionLotFromDatabase(result.rows[0]);
  }

  /**
   * Find all expired active lots (bid_deadline has passed)
   */
  async findExpiredLots(): Promise<AuctionLot[]> {
    const result = await this.db.query(
      `SELECT * FROM auction_lots
       WHERE status = 'active' AND bid_deadline < NOW()
       ORDER BY bid_deadline ASC`
    );
    return result.rows.map(auctionLotFromDatabase);
  }

  /**
   * Upsert a proxy bid (insert or update if exists)
   */
  async upsertProxyBid(lotId: number, rosterId: number, maxBid: number): Promise<AuctionProxyBid> {
    const result = await this.db.query(
      `INSERT INTO auction_proxy_bids (lot_id, roster_id, max_bid)
       VALUES ($1, $2, $3)
       ON CONFLICT (lot_id, roster_id)
       DO UPDATE SET max_bid = EXCLUDED.max_bid, updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [lotId, rosterId, maxBid]
    );
    return auctionProxyBidFromDatabase(result.rows[0]);
  }

  /**
   * Get all proxy bids for a lot, ordered by max_bid descending
   */
  async getAllProxyBidsForLot(lotId: number): Promise<AuctionProxyBid[]> {
    const result = await this.db.query(
      `SELECT * FROM auction_proxy_bids
       WHERE lot_id = $1
       ORDER BY max_bid DESC, updated_at ASC`,
      [lotId]
    );
    return result.rows.map(auctionProxyBidFromDatabase);
  }

  /**
   * Get a specific proxy bid for a lot and roster
   */
  async getProxyBid(lotId: number, rosterId: number): Promise<AuctionProxyBid | null> {
    const result = await this.db.query(
      `SELECT * FROM auction_proxy_bids
       WHERE lot_id = $1 AND roster_id = $2`,
      [lotId, rosterId]
    );
    return result.rows.length > 0 ? auctionProxyBidFromDatabase(result.rows[0]) : null;
  }

  /**
   * Record a bid in the history
   */
  async recordBidHistory(
    lotId: number,
    rosterId: number,
    amount: number,
    isProxy: boolean
  ): Promise<AuctionBidHistory> {
    const result = await this.db.query(
      `INSERT INTO auction_bid_history (lot_id, roster_id, bid_amount, is_proxy)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [lotId, rosterId, amount, isProxy]
    );
    return auctionBidHistoryFromDatabase(result.rows[0]);
  }

  /**
   * Get bid history for a lot
   */
  async getBidHistoryForLot(lotId: number): Promise<AuctionBidHistory[]> {
    const result = await this.db.query(
      `SELECT * FROM auction_bid_history
       WHERE lot_id = $1
       ORDER BY created_at ASC`,
      [lotId]
    );
    return result.rows.map(auctionBidHistoryFromDatabase);
  }

  /**
   * Get roster budget data: spent, won count, and leading commitment
   */
  async getRosterBudgetData(draftId: number, rosterId: number): Promise<RosterBudgetData> {
    // Get sum of winning bids and count of won lots
    const wonResult = await this.db.query(
      `SELECT COALESCE(SUM(winning_bid), 0) as spent, COUNT(*) as won_count
       FROM auction_lots
       WHERE draft_id = $1 AND winning_roster_id = $2 AND status = 'won'`,
      [draftId, rosterId]
    );

    // Get sum of current_bid where this roster is the leading bidder on active lots
    const leadingResult = await this.db.query(
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
   * Get budget data for all rosters in a draft (optimized batch query)
   */
  async getAllRosterBudgetData(
    draftId: number,
    rosterIds: number[]
  ): Promise<Map<number, RosterBudgetData>> {
    if (rosterIds.length === 0) {
      return new Map();
    }

    // Get spent and won counts for all rosters
    const wonResult = await this.db.query(
      `SELECT winning_roster_id as roster_id,
              COALESCE(SUM(winning_bid), 0) as spent,
              COUNT(*) as won_count
       FROM auction_lots
       WHERE draft_id = $1 AND winning_roster_id = ANY($2) AND status = 'won'
       GROUP BY winning_roster_id`,
      [draftId, rosterIds]
    );

    // Get leading commitments for all rosters
    const leadingResult = await this.db.query(
      `SELECT current_bidder_roster_id as roster_id,
              COALESCE(SUM(current_bid), 0) as leading_commitment
       FROM auction_lots
       WHERE draft_id = $1 AND current_bidder_roster_id = ANY($2) AND status = 'active'
       GROUP BY current_bidder_roster_id`,
      [draftId, rosterIds]
    );

    // Build result map with all rosters initialized to zero
    const result = new Map<number, RosterBudgetData>();
    for (const rosterId of rosterIds) {
      result.set(rosterId, { spent: 0, wonCount: 0, leadingCommitment: 0 });
    }

    // Fill in won data
    for (const row of wonResult.rows) {
      const data = result.get(row.roster_id);
      if (data) {
        data.spent = parseInt(row.spent, 10);
        data.wonCount = parseInt(row.won_count, 10);
      }
    }

    // Fill in leading data
    for (const row of leadingResult.rows) {
      const data = result.get(row.roster_id);
      if (data) {
        data.leadingCommitment = parseInt(row.leading_commitment, 10);
      }
    }

    return result;
  }
}
