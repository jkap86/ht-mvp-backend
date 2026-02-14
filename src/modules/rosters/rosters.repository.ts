import { Pool, PoolClient } from 'pg';
import {
  RosterPlayer,
  RosterTransaction,
  rosterPlayerFromDatabase,
  rosterTransactionFromDatabase,
  RosterPlayerWithDetails,
  AcquiredType,
  TransactionType,
} from './rosters.model';

export class RosterPlayersRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Get all players on a roster with their details
   */
  async getByRosterId(rosterId: number): Promise<RosterPlayerWithDetails[]> {
    const result = await this.db.query(
      `SELECT rp.*, p.full_name, p.position, p.team, p.status, p.injury_status
       FROM roster_players rp
       JOIN players p ON rp.player_id = p.id
       WHERE rp.roster_id = $1
       ORDER BY p.position, p.full_name`,
      [rosterId]
    );

    return result.rows.map((row) => ({
      ...rosterPlayerFromDatabase(row),
      fullName: row.full_name,
      position: row.position,
      team: row.team,
      status: row.status,
      injuryStatus: row.injury_status,
    }));
  }

  /**
   * Get all players on a roster with their details using an existing client (for transactions)
   */
  async getByRosterIdWithClient(client: PoolClient, rosterId: number): Promise<RosterPlayerWithDetails[]> {
    const result = await client.query(
      `SELECT rp.*, p.full_name, p.position, p.team, p.status, p.injury_status
       FROM roster_players rp
       JOIN players p ON rp.player_id = p.id
       WHERE rp.roster_id = $1
       ORDER BY p.position, p.full_name`,
      [rosterId]
    );

    return result.rows.map((row) => ({
      ...rosterPlayerFromDatabase(row),
      fullName: row.full_name,
      position: row.position,
      team: row.team,
      status: row.status,
      injuryStatus: row.injury_status,
    }));
  }

  /**
   * Get a specific player on a roster.
   *
   * @param rosterId - Roster ID
   * @param playerId - Player ID
   * @param client - Optional client for use within transactions.
   *                 **WARNING: Caller MUST ensure connection release via try/finally.**
   *                 Prefer using transaction helpers (runInTransaction, runWithLock) instead.
   * @returns RosterPlayer or null if not found
   *
   * @example
   * // PREFERRED: Use transaction helpers
   * await runInTransaction(pool, async (client) => {
   *   const rosterPlayer = await repo.findByRosterAndPlayer(rosterId, playerId, client);
   *   if (rosterPlayer) await repo.removePlayer(rosterId, playerId, client);
   * });
   *
   * @example
   * // ACCEPTABLE: Single read without transaction
   * const rosterPlayer = await repo.findByRosterAndPlayer(rosterId, playerId);
   */
  async findByRosterAndPlayer(
    rosterId: number,
    playerId: number,
    client?: PoolClient
  ): Promise<RosterPlayer | null> {
    const db = client || this.db;
    const result = await db.query(
      'SELECT * FROM roster_players WHERE roster_id = $1 AND player_id = $2',
      [rosterId, playerId]
    );

    if (result.rows.length === 0) return null;
    return rosterPlayerFromDatabase(result.rows[0]);
  }

  /**
   * Check if a player is on any roster in a league (current season).
   *
   * @param leagueId - League ID
   * @param playerId - Player ID
   * @param client - Optional client for use within transactions.
   *                 **WARNING: Caller MUST ensure connection release via try/finally.**
   *                 Prefer using transaction helpers instead.
   * @param leagueSeasonId - Optional league season ID for more precise scoping
   * @returns Roster ID owning the player, or null if free agent
   */
  async findOwner(leagueId: number, playerId: number, client?: PoolClient, leagueSeasonId?: number): Promise<number | null> {
    const db = client || this.db;
    if (leagueSeasonId) {
      const result = await db.query(
        `SELECT rp.roster_id
         FROM roster_players rp
         JOIN rosters r ON rp.roster_id = r.id
         WHERE r.league_season_id = $1 AND rp.player_id = $2`,
        [leagueSeasonId, playerId]
      );
      if (result.rows.length === 0) return null;
      return result.rows[0].roster_id;
    }
    // Fallback: legacy league_id-only scoping
    const result = await db.query(
      `SELECT rp.roster_id
       FROM roster_players rp
       JOIN rosters r ON rp.roster_id = r.id
       WHERE r.league_id = $1 AND rp.player_id = $2`,
      [leagueId, playerId]
    );

    if (result.rows.length === 0) return null;
    return result.rows[0].roster_id;
  }

  /**
   * Add a player to a roster.
   *
   * @param rosterId - Roster ID
   * @param playerId - Player ID
   * @param acquiredType - How the player was acquired (draft, waiver, trade, etc.)
   * @param client - Optional client for use within transactions.
   *                 **WARNING: Caller MUST ensure connection release via try/finally.**
   *                 Prefer using transaction helpers (runWithLock) instead.
   * @returns Created RosterPlayer record
   *
   * @example
   * // PREFERRED: Use transaction helpers with locking
   * await runWithLock(pool, LockDomain.ROSTER, rosterId, async (client) => {
   *   const rosterPlayer = await repo.addPlayer(rosterId, playerId, 'draft', client);
   *   await logTransaction(client, rosterId, 'add', playerId);
   * });
   */
  async addPlayer(
    rosterId: number,
    playerId: number,
    acquiredType: AcquiredType,
    client?: PoolClient
  ): Promise<RosterPlayer> {
    const db = client || this.db;
    const result = await db.query(
      `INSERT INTO roster_players (roster_id, player_id, acquired_type)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [rosterId, playerId, acquiredType]
    );

    return rosterPlayerFromDatabase(result.rows[0]);
  }

  /**
   * Remove a player from a roster.
   *
   * @param rosterId - Roster ID
   * @param playerId - Player ID
   * @param client - Optional client for use within transactions.
   *                 **WARNING: Caller MUST ensure connection release via try/finally.**
   *                 Prefer using transaction helpers (runWithLock) instead.
   * @returns true if player was removed, false if not found
   */
  async removePlayer(rosterId: number, playerId: number, client?: PoolClient): Promise<boolean> {
    const db = client || this.db;
    const result = await db.query(
      'DELETE FROM roster_players WHERE roster_id = $1 AND player_id = $2',
      [rosterId, playerId]
    );

    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Get roster player count.
   *
   * @param rosterId - Roster ID
   * @param client - Optional client for use within transactions.
   *                 **WARNING: Caller MUST ensure connection release via try/finally.**
   * @returns Number of players on the roster
   */
  async getPlayerCount(rosterId: number, client?: PoolClient): Promise<number> {
    const db = client || this.db;
    const result = await db.query(
      'SELECT COUNT(*) as count FROM roster_players WHERE roster_id = $1',
      [rosterId]
    );
    return Number(result.rows[0].count) || 0;
  }

  /**
   * Get all free agents in a league (players not on any roster in current season)
   */
  async getFreeAgents(
    leagueId: number,
    position?: string,
    search?: string,
    limit: number = 50,
    offset: number = 0,
    leagueMode?: string,
    leagueSeasonId?: number
  ): Promise<any[]> {
    const params: any[] = [leagueSeasonId || leagueId, limit, offset];
    const rosterFilter = leagueSeasonId ? 'r.league_season_id = $1' : 'r.league_id = $1';

    // Use LEFT JOIN ... WHERE IS NULL instead of NOT IN for better performance
    // This avoids a full table scan on the subquery
    let whereClause = `
      WHERE p.active = true
        AND rp.player_id IS NULL
    `;

    // Filter out college players for non-devy leagues
    if (leagueMode !== 'devy') {
      whereClause += ` AND (p.player_type IS NULL OR p.player_type != 'college')`;
    }

    if (position) {
      params.push(position);
      whereClause += ` AND p.position = $${params.length}`;
    }

    if (search) {
      // Escape LIKE wildcards to prevent enumeration via % or _
      const escapedSearch = search.replace(/[%_\\]/g, '\\$&');
      params.push(`%${escapedSearch}%`);
      whereClause += ` AND p.full_name ILIKE $${params.length} ESCAPE '\\'`;
    }

    const result = await this.db.query(
      `SELECT p.*
       FROM players p
       LEFT JOIN (
         SELECT rp.player_id
         FROM roster_players rp
         JOIN rosters r ON rp.roster_id = r.id
         WHERE ${rosterFilter}
       ) rp ON p.id = rp.player_id
       ${whereClause}
       ORDER BY p.position, p.full_name
       LIMIT $2 OFFSET $3`,
      params
    );

    return result.rows;
  }

  /**
   * Add a player via draft (records transaction)
   */
  async addDraftedPlayer(
    rosterId: number,
    playerId: number,
    leagueId: number,
    season: number,
    week: number = 0,
    client?: PoolClient
  ): Promise<RosterPlayer> {
    const db = client || this.db;

    // Add to roster
    const rosterPlayer = await this.addPlayer(rosterId, playerId, 'draft', client);

    // Record transaction
    await db.query(
      `INSERT INTO roster_transactions (league_id, roster_id, player_id, transaction_type, season, week)
       VALUES ($1, $2, $3, 'add', $4, $5)`,
      [leagueId, rosterId, playerId, season, week]
    );

    return rosterPlayer;
  }

  /**
   * Delete all players from a roster (for kick member)
   */
  async deleteAllByRosterId(rosterId: number, client?: PoolClient): Promise<number> {
    const db = client || this.db;
    const result = await db.query('DELETE FROM roster_players WHERE roster_id = $1', [rosterId]);
    return result.rowCount || 0;
  }

  /**
   * Get all player IDs on a roster (for waiver processing state tracking)
   */
  async getPlayerIdsByRoster(rosterId: number, client?: PoolClient): Promise<number[]> {
    const db = client || this.db;
    const result = await db.query(
      'SELECT player_id FROM roster_players WHERE roster_id = $1',
      [rosterId]
    );
    return result.rows.map((row) => row.player_id);
  }

  /**
   * Get all owned player IDs in a league (for waiver processing preload).
   * Returns complete league-wide ownership to avoid ConflictException churn
   * when claims target players owned by rosters that have no claims.
   */
  async getOwnedPlayerIdsByLeague(leagueId: number, client?: PoolClient, leagueSeasonId?: number): Promise<Set<number>> {
    const db = client || this.db;
    if (leagueSeasonId) {
      const result = await db.query(
        `SELECT rp.player_id
         FROM roster_players rp
         JOIN rosters r ON r.id = rp.roster_id
         WHERE r.league_season_id = $1`,
        [leagueSeasonId]
      );
      return new Set(result.rows.map((row) => row.player_id));
    }
    const result = await db.query(
      `SELECT rp.player_id
       FROM roster_players rp
       JOIN rosters r ON r.id = rp.roster_id
       WHERE r.league_id = $1`,
      [leagueId]
    );
    return new Set(result.rows.map((row) => row.player_id));
  }
}

export class RosterTransactionsRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Get transactions for a league (season-scoped when leagueSeasonId provided)
   */
  async getByLeague(
    leagueId: number,
    limit: number = 50,
    offset: number = 0,
    leagueSeasonId?: number
  ): Promise<RosterTransaction[]> {
    if (leagueSeasonId) {
      const result = await this.db.query(
        `SELECT rt.*, p.full_name as player_name, r.settings->>'team_name' as team_name
         FROM roster_transactions rt
         JOIN players p ON rt.player_id = p.id
         JOIN rosters r ON rt.roster_id = r.id
         WHERE rt.league_season_id = $1
         ORDER BY rt.created_at DESC
         LIMIT $2 OFFSET $3`,
        [leagueSeasonId, limit, offset]
      );
      return result.rows.map(rosterTransactionFromDatabase);
    }
    const result = await this.db.query(
      `SELECT rt.*, p.full_name as player_name, r.settings->>'team_name' as team_name
       FROM roster_transactions rt
       JOIN players p ON rt.player_id = p.id
       JOIN rosters r ON rt.roster_id = r.id
       WHERE rt.league_id = $1
       ORDER BY rt.created_at DESC
       LIMIT $2 OFFSET $3`,
      [leagueId, limit, offset]
    );

    return result.rows.map(rosterTransactionFromDatabase);
  }

  /**
   * Get transactions for a roster
   */
  async getByRoster(
    rosterId: number,
    limit: number = 50,
    offset: number = 0
  ): Promise<RosterTransaction[]> {
    const result = await this.db.query(
      `SELECT rt.*, p.full_name as player_name
       FROM roster_transactions rt
       JOIN players p ON rt.player_id = p.id
       WHERE rt.roster_id = $1
       ORDER BY rt.created_at DESC
       LIMIT $2 OFFSET $3`,
      [rosterId, limit, offset]
    );

    return result.rows.map(rosterTransactionFromDatabase);
  }

  /**
   * Find a transaction by idempotency key (for replay detection)
   */
  async findByIdempotencyKey(
    leagueId: number,
    rosterId: number,
    idempotencyKey: string,
    client?: PoolClient
  ): Promise<RosterTransaction | null> {
    const db = client || this.db;
    const result = await db.query(
      `SELECT * FROM roster_transactions
       WHERE league_id = $1 AND roster_id = $2 AND idempotency_key = $3`,
      [leagueId, rosterId, idempotencyKey]
    );
    if (result.rows.length === 0) return null;
    return rosterTransactionFromDatabase(result.rows[0]);
  }

  /**
   * Record a transaction
   */
  async create(
    leagueId: number,
    rosterId: number,
    playerId: number,
    transactionType: TransactionType,
    season: number,
    week: number,
    relatedTransactionId?: number,
    client?: PoolClient,
    leagueSeasonId?: number,
    idempotencyKey?: string
  ): Promise<RosterTransaction> {
    const db = client || this.db;
    // Concurrency-safe: ON CONFLICT replaces check-then-insert race
    if (leagueSeasonId) {
      const result = await db.query(
        `INSERT INTO roster_transactions (league_id, roster_id, player_id, transaction_type, season, week, related_transaction_id, league_season_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (league_id, roster_id, idempotency_key) WHERE idempotency_key IS NOT NULL
         DO NOTHING
         RETURNING *`,
        [leagueId, rosterId, playerId, transactionType, season, week, relatedTransactionId || null, leagueSeasonId, idempotencyKey || null]
      );
      if (result.rows.length > 0) {
        return rosterTransactionFromDatabase(result.rows[0]);
      }
      // Conflict: re-select existing transaction by idempotency key
      const existing = await this.findByIdempotencyKey(leagueId, rosterId, idempotencyKey!, db as PoolClient);
      return existing!;
    }
    const result = await db.query(
      `INSERT INTO roster_transactions (league_id, roster_id, player_id, transaction_type, season, week, related_transaction_id, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (league_id, roster_id, idempotency_key) WHERE idempotency_key IS NOT NULL
       DO NOTHING
       RETURNING *`,
      [leagueId, rosterId, playerId, transactionType, season, week, relatedTransactionId || null, idempotencyKey || null]
    );

    if (result.rows.length > 0) {
      return rosterTransactionFromDatabase(result.rows[0]);
    }
    // Conflict: re-select existing transaction by idempotency key
    const existing = await this.findByIdempotencyKey(leagueId, rosterId, idempotencyKey!, db as PoolClient);
    return existing!;
  }
}
