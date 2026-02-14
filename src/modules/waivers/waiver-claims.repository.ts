import { Pool, PoolClient } from 'pg';
import {
  WaiverClaim,
  WaiverClaimWithDetails,
  WaiverClaimStatus,
  waiverClaimFromDatabase,
} from './waivers.model';

/**
 * Extended claim type with current priority (from waiver_priority table)
 */
export interface WaiverClaimWithCurrentPriority extends WaiverClaim {
  currentPriority: number | null;
}

/**
 * Repository for waiver claims
 */
export class WaiverClaimsRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Create a new claim
   */
  async create(
    leagueId: number,
    rosterId: number,
    playerId: number,
    dropPlayerId: number | null,
    bidAmount: number,
    priorityAtClaim: number | null,
    season: number,
    week: number,
    claimOrder: number,
    client?: PoolClient,
    idempotencyKey?: string
  ): Promise<WaiverClaim> {
    const conn = client || this.db;
    // Concurrency-safe: ON CONFLICT replaces check-then-insert race
    const result = await conn.query(
      `INSERT INTO waiver_claims (
        league_id, roster_id, player_id, drop_player_id,
        bid_amount, priority_at_claim, season, week, claim_order, idempotency_key
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (league_id, roster_id, idempotency_key) WHERE idempotency_key IS NOT NULL
      DO NOTHING
      RETURNING *`,
      [
        leagueId,
        rosterId,
        playerId,
        dropPlayerId,
        bidAmount,
        priorityAtClaim,
        season,
        week,
        claimOrder,
        idempotencyKey || null,
      ]
    );

    if (result.rows.length > 0) {
      return waiverClaimFromDatabase(result.rows[0]);
    }

    // Conflict: re-select existing claim by idempotency key
    const existing = await conn.query(
      `SELECT * FROM waiver_claims
       WHERE league_id = $1 AND roster_id = $2 AND idempotency_key = $3`,
      [leagueId, rosterId, idempotencyKey]
    );
    return waiverClaimFromDatabase(existing.rows[0]);
  }

  /**
   * Get the next claim order for a roster's pending claims in the current week.
   * Returns max(claim_order) + 1, or 1 if no pending claims exist.
   */
  async getNextClaimOrder(
    rosterId: number,
    season: number,
    week: number,
    client?: PoolClient
  ): Promise<number> {
    const conn = client || this.db;
    const result = await conn.query(
      `SELECT COALESCE(MAX(claim_order), 0) + 1 as next_order
       FROM waiver_claims
       WHERE roster_id = $1 AND season = $2 AND week = $3 AND status = 'pending'`,
      [rosterId, season, week]
    );
    return Number(result.rows[0].next_order) || 1;
  }

  /**
   * Reorder claims for a roster atomically.
   * Accepts an array of claim IDs in the desired order.
   * Returns the updated claims.
   */
  async reorderClaims(
    rosterId: number,
    claimIds: number[],
    client?: PoolClient
  ): Promise<WaiverClaim[]> {
    const conn = client || this.db;

    if (claimIds.length === 0) {
      return [];
    }

    // Build parameterized VALUES clause: ($2, $3), ($4, $5), ...
    // This avoids string interpolation for security
    const valuesParts: string[] = [];
    const params: number[] = [rosterId]; // $1 is rosterId

    claimIds.forEach((id, index) => {
      const idParam = params.length + 1; // $2, $4, $6, ...
      const orderParam = params.length + 2; // $3, $5, $7, ...
      valuesParts.push(`($${idParam}::INTEGER, $${orderParam}::INTEGER)`);
      params.push(id, index + 1);
    });

    const result = await conn.query(
      `WITH new_orders(id, new_order) AS (
         VALUES ${valuesParts.join(',')}
       )
       UPDATE waiver_claims wc
       SET claim_order = no.new_order, updated_at = NOW()
       FROM new_orders no
       WHERE wc.id = no.id
         AND wc.roster_id = $1
         AND wc.status = 'pending'
       RETURNING wc.*`,
      params
    );

    return result.rows.map(waiverClaimFromDatabase);
  }

  /**
   * Get claim by ID
   */
  async findById(claimId: number, client?: PoolClient): Promise<WaiverClaim | null> {
    const conn = client || this.db;
    const result = await conn.query('SELECT * FROM waiver_claims WHERE id = $1', [claimId]);
    return result.rows.length > 0 ? waiverClaimFromDatabase(result.rows[0]) : null;
  }

  /**
   * Get claim by ID with player/team details
   */
  async findByIdWithDetails(claimId: number): Promise<WaiverClaimWithDetails | null> {
    const result = await this.db.query(
      `SELECT wc.*,
        r.settings->>'team_name' as team_name,
        u.username as username,
        p.full_name as player_name,
        p.position as player_position,
        p.team as player_team,
        dp.full_name as drop_player_name,
        dp.position as drop_player_position
      FROM waiver_claims wc
      JOIN rosters r ON r.id = wc.roster_id
      JOIN users u ON u.id = r.user_id
      JOIN players p ON p.id = wc.player_id
      LEFT JOIN players dp ON dp.id = wc.drop_player_id
      WHERE wc.id = $1`,
      [claimId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      ...waiverClaimFromDatabase(row),
      teamName: row.team_name || `Team ${row.roster_id}`,
      username: row.username || 'Unknown',
      playerName: row.player_name || 'Unknown',
      playerPosition: row.player_position,
      playerTeam: row.player_team,
      dropPlayerName: row.drop_player_name,
      dropPlayerPosition: row.drop_player_position,
    };
  }

  /**
   * Find claim by idempotency key with details
   */
  async findByIdempotencyKey(
    leagueId: number,
    rosterId: number,
    idempotencyKey: string,
    client?: PoolClient
  ): Promise<WaiverClaimWithDetails | null> {
    const conn = client || this.db;
    const result = await conn.query(
      `SELECT wc.*,
        r.settings->>'team_name' as team_name,
        u.username as username,
        p.full_name as player_name,
        p.position as player_position,
        p.team as player_team,
        dp.full_name as drop_player_name,
        dp.position as drop_player_position
      FROM waiver_claims wc
      JOIN rosters r ON r.id = wc.roster_id
      JOIN users u ON u.id = r.user_id
      JOIN players p ON p.id = wc.player_id
      LEFT JOIN players dp ON dp.id = wc.drop_player_id
      WHERE wc.league_id = $1 AND wc.roster_id = $2 AND wc.idempotency_key = $3`,
      [leagueId, rosterId, idempotencyKey]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      ...waiverClaimFromDatabase(row),
      teamName: row.team_name || `Team ${row.roster_id}`,
      username: row.username || 'Unknown',
      playerName: row.player_name || 'Unknown',
      playerPosition: row.player_position,
      playerTeam: row.player_team,
      dropPlayerName: row.drop_player_name,
      dropPlayerPosition: row.drop_player_position,
    };
  }

  /**
   * Get pending claims for a roster with details, ordered by claim_order
   */
  async getPendingByRoster(
    rosterId: number,
    client?: PoolClient
  ): Promise<WaiverClaimWithDetails[]> {
    const conn = client || this.db;
    const result = await conn.query(
      `SELECT wc.*,
        r.settings->>'team_name' as team_name,
        u.username as username,
        p.full_name as player_name,
        p.position as player_position,
        p.team as player_team,
        dp.full_name as drop_player_name,
        dp.position as drop_player_position
      FROM waiver_claims wc
      JOIN rosters r ON r.id = wc.roster_id
      JOIN users u ON u.id = r.user_id
      JOIN players p ON p.id = wc.player_id
      LEFT JOIN players dp ON dp.id = wc.drop_player_id
      WHERE wc.roster_id = $1 AND wc.status = 'pending'
      ORDER BY wc.claim_order ASC`,
      [rosterId]
    );

    return result.rows.map((row) => ({
      ...waiverClaimFromDatabase(row),
      teamName: row.team_name || `Team ${row.roster_id}`,
      username: row.username || 'Unknown',
      playerName: row.player_name || 'Unknown',
      playerPosition: row.player_position,
      playerTeam: row.player_team,
      dropPlayerName: row.drop_player_name,
      dropPlayerPosition: row.drop_player_position,
    }));
  }

  /**
   * Get all pending claims for a league (for processing)
   * Now requires season and week to prevent processing stale claims
   */
  async getPendingByLeague(
    leagueId: number,
    season: number,
    week: number,
    client?: PoolClient
  ): Promise<WaiverClaim[]> {
    const conn = client || this.db;
    const result = await conn.query(
      `SELECT * FROM waiver_claims
       WHERE league_id = $1 AND status = 'pending' AND season = $2 AND week = $3
       ORDER BY player_id, bid_amount DESC, priority_at_claim ASC, created_at ASC`,
      [leagueId, season, week]
    );
    return result.rows.map(waiverClaimFromDatabase);
  }

  /**
   * Get all pending claims for a league with current priority from waiver_priority table
   * This is used for round-based processing where we need claims ordered by roster and claim_order
   */
  async getPendingByLeagueWithCurrentPriority(
    leagueId: number,
    season: number,
    week: number,
    client?: PoolClient
  ): Promise<WaiverClaimWithCurrentPriority[]> {
    const conn = client || this.db;
    const result = await conn.query(
      `SELECT wc.*, wp.priority as current_priority
       FROM waiver_claims wc
       LEFT JOIN waiver_priority wp ON wp.roster_id = wc.roster_id
         AND wp.league_id = wc.league_id AND wp.season = $2
       WHERE wc.league_id = $1 AND wc.status = 'pending' AND wc.season = $2 AND wc.week = $3
       ORDER BY wc.roster_id, wc.claim_order ASC`,
      [leagueId, season, week]
    );
    return result.rows.map((row) => ({
      ...waiverClaimFromDatabase(row),
      currentPriority: row.current_priority !== null ? parseInt(row.current_priority, 10) : null,
    }));
  }

  /**
   * Get pending claims for a specific player in the current season
   */
  async getPendingByPlayer(
    leagueId: number,
    playerId: number,
    client?: PoolClient,
    leagueSeasonId?: number
  ): Promise<WaiverClaim[]> {
    const conn = client || this.db;
    if (leagueSeasonId) {
      const result = await conn.query(
        `SELECT * FROM waiver_claims
         WHERE league_season_id = $1 AND player_id = $2 AND status = 'pending'
         ORDER BY bid_amount DESC, priority_at_claim ASC, created_at ASC`,
        [leagueSeasonId, playerId]
      );
      return result.rows.map(waiverClaimFromDatabase);
    }
    const result = await conn.query(
      `SELECT * FROM waiver_claims
       WHERE league_id = $1 AND player_id = $2 AND status = 'pending'
       ORDER BY bid_amount DESC, priority_at_claim ASC, created_at ASC`,
      [leagueId, playerId]
    );
    return result.rows.map(waiverClaimFromDatabase);
  }

  /**
   * Update claim status
   */
  async updateStatus(
    claimId: number,
    status: WaiverClaimStatus,
    failureReason?: string,
    client?: PoolClient
  ): Promise<WaiverClaim> {
    const conn = client || this.db;
    const processedAt = status !== 'pending' ? new Date() : null;
    const result = await conn.query(
      `UPDATE waiver_claims
       SET status = $2, failure_reason = $3, processed_at = $4
       WHERE id = $1
       RETURNING *`,
      [claimId, status, failureReason || null, processedAt]
    );
    return waiverClaimFromDatabase(result.rows[0]);
  }

  /**
   * Conditionally cancel a claim only if it is still pending.
   * Returns true if the claim was cancelled, false if it was no longer pending.
   * Uses WHERE status = 'pending' to prevent race with concurrent waiver processing.
   */
  async cancelIfPending(claimId: number, client?: PoolClient): Promise<boolean> {
    const conn = client || this.db;
    const result = await conn.query(
      `UPDATE waiver_claims
       SET status = 'cancelled', processed_at = NOW()
       WHERE id = $1 AND status = 'pending'`,
      [claimId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Update bid amount
   */
  async updateBid(claimId: number, bidAmount: number, client?: PoolClient): Promise<WaiverClaim> {
    const conn = client || this.db;
    const result = await conn.query(
      'UPDATE waiver_claims SET bid_amount = $2 WHERE id = $1 RETURNING *',
      [claimId, bidAmount]
    );
    return waiverClaimFromDatabase(result.rows[0]);
  }

  /**
   * Update drop player
   */
  async updateDropPlayer(
    claimId: number,
    dropPlayerId: number | null,
    client?: PoolClient
  ): Promise<WaiverClaim> {
    const conn = client || this.db;
    const result = await conn.query(
      'UPDATE waiver_claims SET drop_player_id = $2 WHERE id = $1 RETURNING *',
      [claimId, dropPlayerId]
    );
    return waiverClaimFromDatabase(result.rows[0]);
  }

  /**
   * Delete claim (for cancellation)
   */
  async delete(claimId: number, client?: PoolClient): Promise<boolean> {
    const conn = client || this.db;
    const result = await conn.query('DELETE FROM waiver_claims WHERE id = $1', [claimId]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Check if roster has pending claim for player
   */
  async hasPendingClaim(rosterId: number, playerId: number, client?: PoolClient): Promise<boolean> {
    const conn = client || this.db;
    const result = await conn.query(
      `SELECT 1 FROM waiver_claims
       WHERE roster_id = $1 AND player_id = $2 AND status = 'pending'`,
      [rosterId, playerId]
    );
    return result.rows.length > 0;
  }

  // ============ Snapshotting Methods ============

  /**
   * Snapshot pending claims for a processing run.
   * Atomically assigns a processing_run_id to all pending claims for a league/week.
   * Returns the number of claims snapshotted.
   *
   * Only claims that:
   * - Are in 'pending' status
   * - Match the season/week
   * - Have NOT already been snapshotted (processing_run_id IS NULL)
   *
   * will be included in the snapshot.
   */
  async snapshotClaimsForProcessingRun(
    leagueId: number,
    season: number,
    week: number,
    processingRunId: number,
    client: PoolClient
  ): Promise<number> {
    const result = await client.query(
      `UPDATE waiver_claims
       SET processing_run_id = $4
       WHERE league_id = $1
         AND season = $2
         AND week = $3
         AND status = 'pending'
         AND processing_run_id IS NULL`,
      [leagueId, season, week, processingRunId]
    );
    return result.rowCount ?? 0;
  }

  /**
   * Get pending claims by processing run ID with current priority.
   * Only returns claims that were snapshotted to this specific processing run.
   * This ensures claims submitted AFTER snapshotting are not included.
   */
  async getPendingByProcessingRun(
    processingRunId: number,
    client: PoolClient
  ): Promise<WaiverClaimWithCurrentPriority[]> {
    const result = await client.query(
      `SELECT wc.*, wp.priority as current_priority
       FROM waiver_claims wc
       LEFT JOIN waiver_priority wp ON wp.roster_id = wc.roster_id
         AND wp.league_id = wc.league_id AND wp.season = wc.season
       WHERE wc.processing_run_id = $1 AND wc.status = 'pending'
       ORDER BY wc.roster_id, wc.claim_order ASC`,
      [processingRunId]
    );
    return result.rows.map((row) => ({
      ...waiverClaimFromDatabase(row),
      currentPriority: row.current_priority !== null ? parseInt(row.current_priority, 10) : null,
    }));
  }

  /**
   * Clear processing_run_id for claims that weren't processed.
   * Called if processing fails and needs to be retried.
   */
  async clearProcessingRunId(processingRunId: number, client: PoolClient): Promise<number> {
    const result = await client.query(
      `UPDATE waiver_claims
       SET processing_run_id = NULL
       WHERE processing_run_id = $1 AND status = 'pending'`,
      [processingRunId]
    );
    return result.rowCount ?? 0;
  }
}
