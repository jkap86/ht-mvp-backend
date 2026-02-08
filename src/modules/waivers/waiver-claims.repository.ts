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
    client?: PoolClient
  ): Promise<WaiverClaim> {
    const conn = client || this.db;
    const result = await conn.query(
      `INSERT INTO waiver_claims (
        league_id, roster_id, player_id, drop_player_id,
        bid_amount, priority_at_claim, season, week
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [leagueId, rosterId, playerId, dropPlayerId, bidAmount, priorityAtClaim, season, week]
    );
    return waiverClaimFromDatabase(result.rows[0]);
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
   * Get pending claims for a roster with details
   */
  async getPendingByRoster(rosterId: number): Promise<WaiverClaimWithDetails[]> {
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
      WHERE wc.roster_id = $1 AND wc.status = 'pending'
      ORDER BY wc.created_at ASC`,
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
   * This is used for processing to ensure we use current priority, not snapshot
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
       ORDER BY wc.player_id, wc.bid_amount DESC, wp.priority ASC NULLS LAST, wc.created_at ASC`,
      [leagueId, season, week]
    );
    return result.rows.map((row) => ({
      ...waiverClaimFromDatabase(row),
      currentPriority: row.current_priority !== null ? parseInt(row.current_priority, 10) : null,
    }));
  }

  /**
   * Get pending claims for a specific player
   */
  async getPendingByPlayer(
    leagueId: number,
    playerId: number,
    client?: PoolClient
  ): Promise<WaiverClaim[]> {
    const conn = client || this.db;
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
}
