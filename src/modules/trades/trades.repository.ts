import { Pool, PoolClient } from 'pg';
import {
  Trade,
  TradeItem,
  TradeVote,
  TradeWithDetails,
  TradeItemWithPlayer,
  TradeVoteWithUser,
  TradeStatus,
  tradeFromDatabase,
  tradeItemFromDatabase,
  tradeVoteFromDatabase,
} from './trades.model';

export class TradesRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Create a new trade
   */
  async create(
    leagueId: number,
    proposerRosterId: number,
    recipientRosterId: number,
    expiresAt: Date,
    season: number,
    week: number,
    message?: string,
    parentTradeId?: number,
    client?: PoolClient
  ): Promise<Trade> {
    const conn = client || this.db;
    const result = await conn.query(
      `INSERT INTO trades (
        league_id, proposer_roster_id, recipient_roster_id,
        expires_at, season, week, message, parent_trade_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [leagueId, proposerRosterId, recipientRosterId, expiresAt, season, week, message || null, parentTradeId || null]
    );
    return tradeFromDatabase(result.rows[0]);
  }

  /**
   * Find trade by ID
   */
  async findById(tradeId: number, client?: PoolClient): Promise<Trade | null> {
    const conn = client || this.db;
    const result = await conn.query('SELECT * FROM trades WHERE id = $1', [tradeId]);
    return result.rows.length > 0 ? tradeFromDatabase(result.rows[0]) : null;
  }

  /**
   * Find trade by ID with full details including items, team names, and votes
   */
  async findByIdWithDetails(tradeId: number, userRosterId?: number): Promise<TradeWithDetails | null> {
    // Get trade with team/user info
    const tradeResult = await this.db.query(
      `SELECT t.*,
        pr.settings->>'team_name' as proposer_team_name,
        pu.display_name as proposer_username,
        rr.settings->>'team_name' as recipient_team_name,
        ru.display_name as recipient_username
      FROM trades t
      JOIN rosters pr ON pr.id = t.proposer_roster_id
      JOIN users pu ON pu.id = pr.user_id
      JOIN rosters rr ON rr.id = t.recipient_roster_id
      JOIN users ru ON ru.id = rr.user_id
      WHERE t.id = $1`,
      [tradeId]
    );

    if (tradeResult.rows.length === 0) return null;

    const row = tradeResult.rows[0];
    const trade = tradeFromDatabase(row);

    // Get items with player details
    const items = await this.getItemsWithDetails(tradeId);

    // Get votes
    const votes = await this.getVotesWithUsers(tradeId);

    // Determine permissions
    const canRespond = userRosterId === trade.recipientRosterId && trade.status === 'pending';
    const canCancel = userRosterId === trade.proposerRosterId && trade.status === 'pending';
    const canVote =
      trade.status === 'in_review' &&
      userRosterId !== undefined &&
      userRosterId !== trade.proposerRosterId &&
      userRosterId !== trade.recipientRosterId &&
      !votes.some((v) => v.rosterId === userRosterId);

    return {
      ...trade,
      items,
      proposerTeamName: row.proposer_team_name || `Team ${trade.proposerRosterId}`,
      recipientTeamName: row.recipient_team_name || `Team ${trade.recipientRosterId}`,
      proposerUsername: row.proposer_username || 'Unknown',
      recipientUsername: row.recipient_username || 'Unknown',
      votes,
      canRespond,
      canCancel,
      canVote,
    };
  }

  /**
   * Find trades for a league with optional status filter
   */
  async findByLeague(
    leagueId: number,
    statuses?: TradeStatus[],
    limit = 50,
    offset = 0
  ): Promise<Trade[]> {
    let query = 'SELECT * FROM trades WHERE league_id = $1';
    const params: any[] = [leagueId];

    if (statuses && statuses.length > 0) {
      query += ` AND status = ANY($${params.length + 1})`;
      params.push(statuses);
    }

    query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(limit, offset);

    const result = await this.db.query(query, params);
    return result.rows.map(tradeFromDatabase);
  }

  /**
   * Find trades involving a specific roster
   */
  async findByRoster(rosterId: number, statuses?: TradeStatus[]): Promise<Trade[]> {
    let query = 'SELECT * FROM trades WHERE (proposer_roster_id = $1 OR recipient_roster_id = $1)';
    const params: any[] = [rosterId];

    if (statuses && statuses.length > 0) {
      query += ` AND status = ANY($${params.length + 1})`;
      params.push(statuses);
    }

    query += ' ORDER BY created_at DESC';

    const result = await this.db.query(query, params);
    return result.rows.map(tradeFromDatabase);
  }

  /**
   * Find pending trades that involve a specific player
   */
  async findPendingByPlayer(leagueId: number, playerId: number): Promise<Trade[]> {
    const result = await this.db.query(
      `SELECT DISTINCT t.* FROM trades t
      JOIN trade_items ti ON ti.trade_id = t.id
      WHERE t.league_id = $1 AND ti.player_id = $2
      AND t.status IN ('pending', 'accepted', 'in_review')`,
      [leagueId, playerId]
    );
    return result.rows.map(tradeFromDatabase);
  }

  /**
   * Update trade status
   * @param expectedStatus - If provided, only update if current status matches (prevents race conditions)
   * @returns Trade if updated, null if expectedStatus didn't match
   */
  async updateStatus(
    tradeId: number,
    status: TradeStatus,
    client?: PoolClient,
    expectedStatus?: TradeStatus
  ): Promise<Trade | null> {
    const conn = client || this.db;
    const completedAt = status === 'completed' ? new Date() : null;

    let query: string;
    let params: any[];

    if (expectedStatus) {
      // Conditional update - only if status matches expected
      query = `UPDATE trades SET status = $1, completed_at = COALESCE($2, completed_at), updated_at = NOW()
        WHERE id = $3 AND status = $4 RETURNING *`;
      params = [status, completedAt, tradeId, expectedStatus];
    } else {
      // Unconditional update (for backwards compatibility in non-race-sensitive paths)
      query = `UPDATE trades SET status = $1, completed_at = COALESCE($2, completed_at), updated_at = NOW()
        WHERE id = $3 RETURNING *`;
      params = [status, completedAt, tradeId];
    }

    const result = await conn.query(query, params);
    return result.rows.length > 0 ? tradeFromDatabase(result.rows[0]) : null;
  }

  /**
   * Set review period for a trade
   * Only updates if trade is still in 'pending' status (prevents race conditions)
   * @returns Trade if updated, null if trade was no longer pending
   */
  async setReviewPeriod(
    tradeId: number,
    reviewStartsAt: Date,
    reviewEndsAt: Date,
    client?: PoolClient
  ): Promise<Trade | null> {
    const conn = client || this.db;
    const result = await conn.query(
      `UPDATE trades SET status = 'in_review', review_starts_at = $1, review_ends_at = $2, updated_at = NOW()
      WHERE id = $3 AND status = 'pending' RETURNING *`,
      [reviewStartsAt, reviewEndsAt, tradeId]
    );
    return result.rows.length > 0 ? tradeFromDatabase(result.rows[0]) : null;
  }

  /**
   * Find expired pending trades
   */
  async findExpiredTrades(): Promise<Trade[]> {
    const result = await this.db.query(
      `SELECT * FROM trades WHERE status = 'pending' AND expires_at < NOW()`
    );
    return result.rows.map(tradeFromDatabase);
  }

  /**
   * Find trades with completed review period
   */
  async findReviewCompleteTrades(): Promise<Trade[]> {
    const result = await this.db.query(
      `SELECT * FROM trades WHERE status = 'in_review' AND review_ends_at < NOW()`
    );
    return result.rows.map(tradeFromDatabase);
  }

  /**
   * Get items with player details
   */
  private async getItemsWithDetails(tradeId: number): Promise<TradeItemWithPlayer[]> {
    const result = await this.db.query(
      `SELECT ti.*, p.full_name, p.position, p.team, p.status
      FROM trade_items ti
      JOIN players p ON p.id = ti.player_id
      WHERE ti.trade_id = $1`,
      [tradeId]
    );
    return result.rows.map((row) => ({
      ...tradeItemFromDatabase(row),
      fullName: row.full_name,
      position: row.position,
      team: row.team,
      status: row.status,
    }));
  }

  /**
   * Get votes with user info
   */
  private async getVotesWithUsers(tradeId: number): Promise<TradeVoteWithUser[]> {
    const result = await this.db.query(
      `SELECT tv.*, u.display_name as username, r.settings->>'team_name' as team_name
      FROM trade_votes tv
      JOIN rosters r ON r.id = tv.roster_id
      JOIN users u ON u.id = r.user_id
      WHERE tv.trade_id = $1`,
      [tradeId]
    );
    return result.rows.map((row) => ({
      ...tradeVoteFromDatabase(row),
      username: row.username || 'Unknown',
      teamName: row.team_name || `Team ${row.roster_id}`,
    }));
  }
}

export class TradeItemsRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Create trade items in bulk
   */
  async createBulk(
    tradeId: number,
    items: Array<{
      playerId: number;
      fromRosterId: number;
      toRosterId: number;
      playerName: string;
      playerPosition?: string;
      playerTeam?: string;
    }>,
    client?: PoolClient
  ): Promise<TradeItem[]> {
    if (items.length === 0) return [];

    const conn = client || this.db;
    const values: any[] = [];
    const placeholders: string[] = [];

    items.forEach((item, index) => {
      const offset = index * 6;
      placeholders.push(
        `($1, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`
      );
      values.push(
        item.playerId,
        item.fromRosterId,
        item.toRosterId,
        item.playerName,
        item.playerPosition || null,
        item.playerTeam || null
      );
    });

    const result = await conn.query(
      `INSERT INTO trade_items (trade_id, player_id, from_roster_id, to_roster_id, player_name, player_position, player_team)
      VALUES ${placeholders.map((_, i) => `($1, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6}, $${i * 6 + 7})`).join(', ')}
      RETURNING *`,
      [tradeId, ...values]
    );

    return result.rows.map(tradeItemFromDatabase);
  }

  /**
   * Find items by trade ID
   */
  async findByTrade(tradeId: number): Promise<TradeItem[]> {
    const result = await this.db.query('SELECT * FROM trade_items WHERE trade_id = $1', [tradeId]);
    return result.rows.map(tradeItemFromDatabase);
  }

  /**
   * Get player IDs in a trade
   */
  async findPlayerIdsInTrade(tradeId: number): Promise<number[]> {
    const result = await this.db.query('SELECT player_id FROM trade_items WHERE trade_id = $1', [tradeId]);
    return result.rows.map((row) => row.player_id);
  }
}

export class TradeVotesRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Create a vote
   */
  async create(
    tradeId: number,
    rosterId: number,
    vote: 'approve' | 'veto',
    client?: PoolClient
  ): Promise<TradeVote> {
    const conn = client || this.db;
    const result = await conn.query(
      `INSERT INTO trade_votes (trade_id, roster_id, vote)
      VALUES ($1, $2, $3) RETURNING *`,
      [tradeId, rosterId, vote]
    );
    return tradeVoteFromDatabase(result.rows[0]);
  }

  /**
   * Find votes by trade ID
   */
  async findByTrade(tradeId: number): Promise<TradeVote[]> {
    const result = await this.db.query('SELECT * FROM trade_votes WHERE trade_id = $1', [tradeId]);
    return result.rows.map(tradeVoteFromDatabase);
  }

  /**
   * Count votes by type
   */
  async countVotes(tradeId: number): Promise<{ approve: number; veto: number }> {
    const result = await this.db.query(
      `SELECT vote, COUNT(*) as count FROM trade_votes
      WHERE trade_id = $1 GROUP BY vote`,
      [tradeId]
    );
    const counts = { approve: 0, veto: 0 };
    result.rows.forEach((row) => {
      counts[row.vote as 'approve' | 'veto'] = parseInt(row.count, 10);
    });
    return counts;
  }

  /**
   * Check if roster has already voted
   */
  async hasVoted(tradeId: number, rosterId: number): Promise<boolean> {
    const result = await this.db.query(
      'SELECT 1 FROM trade_votes WHERE trade_id = $1 AND roster_id = $2',
      [tradeId, rosterId]
    );
    return result.rows.length > 0;
  }
}
