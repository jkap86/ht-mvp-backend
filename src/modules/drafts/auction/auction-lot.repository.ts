import { Pool, PoolClient } from 'pg';
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
    startingBid: number,
    nominationDate?: string
  ): Promise<AuctionLot> {
    // Use provided date or default to today (UTC)
    const nomDate = nominationDate || new Date().toISOString().split('T')[0];
    const result = await this.db.query(
      `INSERT INTO auction_lots (draft_id, player_id, nominator_roster_id, bid_deadline, current_bid, current_bidder_roster_id, status, nomination_date)
       VALUES ($1, $2, $3, $4, $5, NULL, 'active', $6)
       RETURNING *`,
      [draftId, playerId, nominatorRosterId, bidDeadline, startingBid, nomDate]
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
   * Check if a draft has any active lot (fast path for nomination validation)
   */
  async hasActiveLot(draftId: number): Promise<boolean> {
    const result = await this.db.query(
      "SELECT EXISTS(SELECT 1 FROM auction_lots WHERE draft_id = $1 AND status = 'active') as has_active",
      [draftId]
    );
    return result.rows[0].has_active;
  }

  /**
   * Check if a draft has any active lot using transaction client
   */
  async hasActiveLotWithClient(client: PoolClient, draftId: number): Promise<boolean> {
    const result = await client.query(
      "SELECT EXISTS(SELECT 1 FROM auction_lots WHERE draft_id = $1 AND status = 'active') as has_active",
      [draftId]
    );
    return result.rows[0].has_active;
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
   * Count all active lots for a draft (league-wide cap)
   */
  async countAllActiveLots(draftId: number): Promise<number> {
    const result = await this.db.query(
      `SELECT COUNT(*) as count FROM auction_lots
       WHERE draft_id = $1 AND status = 'active'`,
      [draftId]
    );
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Count daily nominations for a roster (for daily limit enforcement)
   */
  async countDailyNominationsForRoster(
    draftId: number,
    rosterId: number,
    date: string
  ): Promise<number> {
    const result = await this.db.query(
      `SELECT COUNT(*) as count FROM auction_lots
       WHERE draft_id = $1 AND nominator_roster_id = $2 AND nomination_date = $3`,
      [draftId, rosterId, date]
    );
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Generic update for a lot
   * @param lotId - The lot ID to update
   * @param updates - The fields to update
   * @param expectedCurrentBid - Optional CAS check: only update if current_bid matches this value
   *                             If provided and the check fails, throws an error
   */
  async updateLot(
    lotId: number,
    updates: Partial<AuctionLot>,
    expectedCurrentBid?: number
  ): Promise<AuctionLot> {
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
    let whereClause = `id = $${paramIndex}`;

    // Add CAS check if expectedCurrentBid is provided
    if (expectedCurrentBid !== undefined) {
      paramIndex++;
      whereClause += ` AND current_bid = $${paramIndex}`;
      values.push(expectedCurrentBid);
    }

    const result = await this.db.query(
      `UPDATE auction_lots SET ${setClauses.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE ${whereClause}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      if (expectedCurrentBid !== undefined) {
        throw new Error('Lot state changed - stale update detected (CAS check failed)');
      }
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
   * Get all player IDs that have been nominated in a draft
   * (includes active, won, and passed lots)
   */
  async getNominatedPlayerIds(draftId: number): Promise<number[]> {
    const result = await this.db.query(
      `SELECT DISTINCT player_id FROM auction_lots WHERE draft_id = $1`,
      [draftId]
    );
    return result.rows.map((row) => row.player_id);
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
       ORDER BY max_bid DESC, created_at ASC`,
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
   * Get all proxy bids for a roster across multiple lots
   * Returns a map of lotId -> maxBid
   */
  async getProxyBidsForRoster(
    lotIds: number[],
    rosterId: number
  ): Promise<Map<number, number>> {
    if (lotIds.length === 0) {
      return new Map();
    }

    const result = await this.db.query(
      `SELECT lot_id, max_bid FROM auction_proxy_bids
       WHERE lot_id = ANY($1) AND roster_id = $2`,
      [lotIds, rosterId]
    );

    const map = new Map<number, number>();
    for (const row of result.rows) {
      map.set(row.lot_id, row.max_bid);
    }
    return map;
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
   * Uses a single query to avoid race conditions between status checks
   */
  async getRosterBudgetData(draftId: number, rosterId: number): Promise<RosterBudgetData> {
    // Single query with conditional aggregation to avoid race conditions
    // between checking won lots and active lots
    const result = await this.db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'won' AND winning_roster_id = $2 THEN winning_bid ELSE 0 END), 0) as spent,
         COUNT(CASE WHEN status = 'won' AND winning_roster_id = $2 THEN 1 END) as won_count,
         COALESCE(SUM(CASE WHEN status = 'active' AND current_bidder_roster_id = $2 THEN current_bid ELSE 0 END), 0) as leading_commitment
       FROM auction_lots
       WHERE draft_id = $1 AND (
         (status = 'won' AND winning_roster_id = $2) OR
         (status = 'active' AND current_bidder_roster_id = $2)
       )`,
      [draftId, rosterId]
    );

    return {
      spent: parseInt(result.rows[0].spent, 10),
      wonCount: parseInt(result.rows[0].won_count, 10),
      leadingCommitment: parseInt(result.rows[0].leading_commitment, 10),
    };
  }

  /**
   * Get budget data for all rosters in a draft (optimized batch query)
   * Uses a single query to avoid race conditions between status checks
   */
  async getAllRosterBudgetData(
    draftId: number,
    rosterIds: number[]
  ): Promise<Map<number, RosterBudgetData>> {
    if (rosterIds.length === 0) {
      return new Map();
    }

    // Single query with conditional aggregation to avoid race conditions
    // Uses UNION to combine won and leading stats per roster
    const queryResult = await this.db.query(
      `WITH roster_stats AS (
         SELECT
           COALESCE(winning_roster_id, current_bidder_roster_id) as roster_id,
           CASE WHEN status = 'won' THEN winning_bid ELSE 0 END as spent_amount,
           CASE WHEN status = 'won' THEN 1 ELSE 0 END as won_flag,
           CASE WHEN status = 'active' THEN current_bid ELSE 0 END as leading_amount
         FROM auction_lots
         WHERE draft_id = $1 AND (
           (status = 'won' AND winning_roster_id = ANY($2)) OR
           (status = 'active' AND current_bidder_roster_id = ANY($2))
         )
       )
       SELECT
         roster_id,
         COALESCE(SUM(spent_amount), 0) as spent,
         COALESCE(SUM(won_flag), 0) as won_count,
         COALESCE(SUM(leading_amount), 0) as leading_commitment
       FROM roster_stats
       GROUP BY roster_id`,
      [draftId, rosterIds]
    );

    // Build result map with all rosters initialized to zero
    const result = new Map<number, RosterBudgetData>();
    for (const rosterId of rosterIds) {
      result.set(rosterId, { spent: 0, wonCount: 0, leadingCommitment: 0 });
    }

    // Fill in data from query
    for (const row of queryResult.rows) {
      const data = result.get(row.roster_id);
      if (data) {
        data.spent = parseInt(row.spent, 10);
        data.wonCount = parseInt(row.won_count, 10);
        data.leadingCommitment = parseInt(row.leading_commitment, 10);
      }
    }

    return result;
  }

  // ============================================================================
  // WithClient methods - for use inside transactions
  // ============================================================================

  /**
   * Creates a new auction lot using an existing transaction client
   */
  async createLotWithClient(
    client: PoolClient,
    draftId: number,
    playerId: number,
    nominatorRosterId: number,
    bidDeadline: Date,
    startingBid: number,
    nominationDate?: string,
    idempotencyKey?: string
  ): Promise<AuctionLot> {
    const nomDate = nominationDate || new Date().toISOString().split('T')[0];
    const result = await client.query(
      `INSERT INTO auction_lots (draft_id, player_id, nominator_roster_id, bid_deadline, current_bid, current_bidder_roster_id, status, nomination_date, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, NULL, 'active', $6, $7)
       RETURNING *`,
      [draftId, playerId, nominatorRosterId, bidDeadline, startingBid, nomDate, idempotencyKey || null]
    );
    return auctionLotFromDatabase(result.rows[0]);
  }

  /**
   * Count active lots for a specific roster using transaction client
   */
  async countActiveLotsForRosterWithClient(
    client: PoolClient,
    draftId: number,
    rosterId: number
  ): Promise<number> {
    const result = await client.query(
      `SELECT COUNT(*) as count FROM auction_lots
       WHERE draft_id = $1 AND nominator_roster_id = $2 AND status = 'active'`,
      [draftId, rosterId]
    );
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Count all active lots for a draft using transaction client
   */
  async countAllActiveLotsWithClient(client: PoolClient, draftId: number): Promise<number> {
    const result = await client.query(
      `SELECT COUNT(*) as count FROM auction_lots
       WHERE draft_id = $1 AND status = 'active'`,
      [draftId]
    );
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Count daily nominations for a roster using transaction client
   */
  async countDailyNominationsForRosterWithClient(
    client: PoolClient,
    draftId: number,
    rosterId: number,
    date: string
  ): Promise<number> {
    const result = await client.query(
      `SELECT COUNT(*) as count FROM auction_lots
       WHERE draft_id = $1 AND nominator_roster_id = $2 AND nomination_date = $3`,
      [draftId, rosterId, date]
    );
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Find a lot by draft and player using transaction client
   */
  async findLotByDraftAndPlayerWithClient(
    client: PoolClient,
    draftId: number,
    playerId: number
  ): Promise<AuctionLot | null> {
    const result = await client.query(
      `SELECT * FROM auction_lots WHERE draft_id = $1 AND player_id = $2 AND status IN ('active', 'won')`,
      [draftId, playerId]
    );
    return result.rows.length > 0 ? auctionLotFromDatabase(result.rows[0]) : null;
  }

  /**
   * Get roster budget data using transaction client
   * Uses a single query to avoid race conditions between status checks
   */
  /**
   * Get budget data for all rosters in a draft using transaction client
   * Uses a single query to avoid race conditions between status checks
   */
  async getAllRosterBudgetDataWithClient(
    client: PoolClient,
    draftId: number,
    rosterIds: number[]
  ): Promise<Map<number, RosterBudgetData>> {
    if (rosterIds.length === 0) {
      return new Map();
    }

    const queryResult = await client.query(
      `WITH roster_stats AS (
         SELECT
           COALESCE(winning_roster_id, current_bidder_roster_id) as roster_id,
           CASE WHEN status = 'won' THEN winning_bid ELSE 0 END as spent_amount,
           CASE WHEN status = 'won' THEN 1 ELSE 0 END as won_flag,
           CASE WHEN status = 'active' THEN current_bid ELSE 0 END as leading_amount
         FROM auction_lots
         WHERE draft_id = $1 AND (
           (status = 'won' AND winning_roster_id = ANY($2)) OR
           (status = 'active' AND current_bidder_roster_id = ANY($2))
         )
       )
       SELECT
         roster_id,
         COALESCE(SUM(spent_amount), 0) as spent,
         COALESCE(SUM(won_flag), 0) as won_count,
         COALESCE(SUM(leading_amount), 0) as leading_commitment
       FROM roster_stats
       GROUP BY roster_id`,
      [draftId, rosterIds]
    );

    const result = new Map<number, RosterBudgetData>();
    for (const rosterId of rosterIds) {
      result.set(rosterId, { spent: 0, wonCount: 0, leadingCommitment: 0 });
    }

    for (const row of queryResult.rows) {
      const data = result.get(row.roster_id);
      if (data) {
        data.spent = parseInt(row.spent, 10);
        data.wonCount = parseInt(row.won_count, 10);
        data.leadingCommitment = parseInt(row.leading_commitment, 10);
      }
    }

    return result;
  }

  async getRosterBudgetDataWithClient(
    client: PoolClient,
    draftId: number,
    rosterId: number
  ): Promise<RosterBudgetData> {
    const result = await client.query(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'won' AND winning_roster_id = $2 THEN winning_bid ELSE 0 END), 0) as spent,
         COUNT(CASE WHEN status = 'won' AND winning_roster_id = $2 THEN 1 END) as won_count,
         COALESCE(SUM(CASE WHEN status = 'active' AND current_bidder_roster_id = $2 THEN current_bid ELSE 0 END), 0) as leading_commitment
       FROM auction_lots
       WHERE draft_id = $1 AND (
         (status = 'won' AND winning_roster_id = $2) OR
         (status = 'active' AND current_bidder_roster_id = $2)
       )`,
      [draftId, rosterId]
    );

    return {
      spent: parseInt(result.rows[0].spent, 10),
      wonCount: parseInt(result.rows[0].won_count, 10),
      leadingCommitment: parseInt(result.rows[0].leading_commitment, 10),
    };
  }
}
