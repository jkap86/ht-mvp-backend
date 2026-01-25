import { Pool, PoolClient } from 'pg';
import {
  WaiverPriority,
  WaiverPriorityWithDetails,
  FaabBudget,
  FaabBudgetWithDetails,
  WaiverClaim,
  WaiverClaimWithDetails,
  WaiverWirePlayer,
  WaiverWirePlayerWithDetails,
  WaiverClaimStatus,
  waiverPriorityFromDatabase,
  faabBudgetFromDatabase,
  waiverClaimFromDatabase,
  waiverWirePlayerFromDatabase,
} from './waivers.model';

/**
 * Repository for waiver priority management
 */
export class WaiverPriorityRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Initialize priorities for all rosters in a league (called at season start)
   */
  async initializeForLeague(
    leagueId: number,
    season: number,
    rosterIds: number[],
    client?: PoolClient
  ): Promise<void> {
    const conn = client || this.db;

    // Delete existing priorities for this league/season
    await conn.query(
      'DELETE FROM waiver_priority WHERE league_id = $1 AND season = $2',
      [leagueId, season]
    );

    // Insert new priorities (order by roster creation for initial)
    for (let i = 0; i < rosterIds.length; i++) {
      await conn.query(
        `INSERT INTO waiver_priority (league_id, roster_id, season, priority)
         VALUES ($1, $2, $3, $4)`,
        [leagueId, rosterIds[i], season, i + 1]
      );
    }
  }

  /**
   * Get priority list for a league/season with team details
   */
  async getByLeague(leagueId: number, season: number): Promise<WaiverPriorityWithDetails[]> {
    const result = await this.db.query(
      `SELECT wp.*,
        r.settings->>'team_name' as team_name,
        u.display_name as username
      FROM waiver_priority wp
      JOIN rosters r ON r.id = wp.roster_id
      JOIN users u ON u.id = r.user_id
      WHERE wp.league_id = $1 AND wp.season = $2
      ORDER BY wp.priority ASC`,
      [leagueId, season]
    );

    return result.rows.map(row => ({
      ...waiverPriorityFromDatabase(row),
      teamName: row.team_name || `Team ${row.roster_id}`,
      username: row.username || 'Unknown',
    }));
  }

  /**
   * Get single roster's priority
   */
  async getByRoster(rosterId: number, season: number, client?: PoolClient): Promise<WaiverPriority | null> {
    const conn = client || this.db;
    const result = await conn.query(
      'SELECT * FROM waiver_priority WHERE roster_id = $1 AND season = $2',
      [rosterId, season]
    );
    return result.rows.length > 0 ? waiverPriorityFromDatabase(result.rows[0]) : null;
  }

  /**
   * Rotate priorities - move successful claimer to last place
   */
  async rotatePriority(
    leagueId: number,
    season: number,
    claimerRosterId: number,
    client?: PoolClient
  ): Promise<void> {
    const conn = client || this.db;

    // Get current priority of claimer
    const claimerResult = await conn.query(
      'SELECT priority FROM waiver_priority WHERE league_id = $1 AND season = $2 AND roster_id = $3',
      [leagueId, season, claimerRosterId]
    );

    if (claimerResult.rows.length === 0) return;

    const claimerPriority = claimerResult.rows[0].priority;

    // Get max priority
    const maxResult = await conn.query(
      'SELECT MAX(priority) as max_priority FROM waiver_priority WHERE league_id = $1 AND season = $2',
      [leagueId, season]
    );

    const maxPriority = maxResult.rows[0].max_priority;

    // Move everyone below claimer up one spot
    await conn.query(
      `UPDATE waiver_priority
       SET priority = priority - 1
       WHERE league_id = $1 AND season = $2 AND priority > $3`,
      [leagueId, season, claimerPriority]
    );

    // Move claimer to last place
    await conn.query(
      `UPDATE waiver_priority
       SET priority = $4
       WHERE league_id = $1 AND season = $2 AND roster_id = $3`,
      [leagueId, season, claimerRosterId, maxPriority]
    );
  }
}

/**
 * Repository for FAAB budget management
 */
export class FaabBudgetRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Initialize FAAB budgets for all rosters in a league
   */
  async initializeForLeague(
    leagueId: number,
    season: number,
    rosterIds: number[],
    initialBudget: number,
    client?: PoolClient
  ): Promise<void> {
    const conn = client || this.db;

    // Delete existing budgets for this league/season
    await conn.query(
      'DELETE FROM faab_budgets WHERE league_id = $1 AND season = $2',
      [leagueId, season]
    );

    // Insert new budgets
    for (const rosterId of rosterIds) {
      await conn.query(
        `INSERT INTO faab_budgets (league_id, roster_id, season, initial_budget, remaining_budget)
         VALUES ($1, $2, $3, $4, $4)`,
        [leagueId, rosterId, season, initialBudget]
      );
    }
  }

  /**
   * Get all budgets for a league with team details
   */
  async getByLeague(leagueId: number, season: number): Promise<FaabBudgetWithDetails[]> {
    const result = await this.db.query(
      `SELECT fb.*,
        r.settings->>'team_name' as team_name,
        u.display_name as username
      FROM faab_budgets fb
      JOIN rosters r ON r.id = fb.roster_id
      JOIN users u ON u.id = r.user_id
      WHERE fb.league_id = $1 AND fb.season = $2
      ORDER BY fb.remaining_budget DESC`,
      [leagueId, season]
    );

    return result.rows.map(row => ({
      ...faabBudgetFromDatabase(row),
      teamName: row.team_name || `Team ${row.roster_id}`,
      username: row.username || 'Unknown',
    }));
  }

  /**
   * Get single roster's budget
   */
  async getByRoster(rosterId: number, season: number, client?: PoolClient): Promise<FaabBudget | null> {
    const conn = client || this.db;
    const result = await conn.query(
      'SELECT * FROM faab_budgets WHERE roster_id = $1 AND season = $2',
      [rosterId, season]
    );
    return result.rows.length > 0 ? faabBudgetFromDatabase(result.rows[0]) : null;
  }

  /**
   * Deduct amount from budget
   */
  async deductBudget(
    rosterId: number,
    season: number,
    amount: number,
    client?: PoolClient
  ): Promise<FaabBudget> {
    const conn = client || this.db;
    const result = await conn.query(
      `UPDATE faab_budgets
       SET remaining_budget = remaining_budget - $3
       WHERE roster_id = $1 AND season = $2
       RETURNING *`,
      [rosterId, season, amount]
    );

    if (result.rows.length === 0) {
      throw new Error(`FAAB budget not found for roster ${rosterId} season ${season}`);
    }

    return faabBudgetFromDatabase(result.rows[0]);
  }
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
        u.display_name as username,
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
        u.display_name as username,
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

    return result.rows.map(row => ({
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
   */
  async getPendingByLeague(leagueId: number, client?: PoolClient): Promise<WaiverClaim[]> {
    const conn = client || this.db;
    const result = await conn.query(
      `SELECT * FROM waiver_claims
       WHERE league_id = $1 AND status = 'pending'
       ORDER BY player_id, bid_amount DESC, priority_at_claim ASC, created_at ASC`,
      [leagueId]
    );
    return result.rows.map(waiverClaimFromDatabase);
  }

  /**
   * Get pending claims for a specific player
   */
  async getPendingByPlayer(leagueId: number, playerId: number, client?: PoolClient): Promise<WaiverClaim[]> {
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
  async updateDropPlayer(claimId: number, dropPlayerId: number | null, client?: PoolClient): Promise<WaiverClaim> {
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

/**
 * Repository for waiver wire (recently dropped players)
 */
export class WaiverWireRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Add player to waiver wire
   */
  async addPlayer(
    leagueId: number,
    playerId: number,
    droppedByRosterId: number | null,
    expiresAt: Date,
    season: number,
    week: number,
    client?: PoolClient
  ): Promise<WaiverWirePlayer> {
    const conn = client || this.db;

    // Upsert - update expiration if already on waivers
    const result = await conn.query(
      `INSERT INTO waiver_wire (league_id, player_id, dropped_by_roster_id, waiver_expires_at, season, week)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (league_id, player_id)
       DO UPDATE SET waiver_expires_at = $4, dropped_by_roster_id = $3, season = $5, week = $6
       RETURNING *`,
      [leagueId, playerId, droppedByRosterId, expiresAt, season, week]
    );
    return waiverWirePlayerFromDatabase(result.rows[0]);
  }

  /**
   * Remove player from waiver wire
   */
  async removePlayer(leagueId: number, playerId: number, client?: PoolClient): Promise<boolean> {
    const conn = client || this.db;
    const result = await conn.query(
      'DELETE FROM waiver_wire WHERE league_id = $1 AND player_id = $2',
      [leagueId, playerId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Check if player is on waiver wire
   */
  async isOnWaivers(leagueId: number, playerId: number, client?: PoolClient): Promise<boolean> {
    const conn = client || this.db;
    const result = await conn.query(
      `SELECT 1 FROM waiver_wire
       WHERE league_id = $1 AND player_id = $2 AND waiver_expires_at > NOW()`,
      [leagueId, playerId]
    );
    return result.rows.length > 0;
  }

  /**
   * Get waiver wire expiration for a player
   */
  async getPlayerExpiration(leagueId: number, playerId: number, client?: PoolClient): Promise<Date | null> {
    const conn = client || this.db;
    const result = await conn.query(
      'SELECT waiver_expires_at FROM waiver_wire WHERE league_id = $1 AND player_id = $2',
      [leagueId, playerId]
    );
    return result.rows.length > 0 ? result.rows[0].waiver_expires_at : null;
  }

  /**
   * Get all players on waiver wire for a league
   */
  async getByLeague(leagueId: number): Promise<WaiverWirePlayerWithDetails[]> {
    const result = await this.db.query(
      `SELECT ww.*,
        p.full_name as player_name,
        p.position as player_position,
        p.team as player_team,
        r.settings->>'team_name' as dropped_by_team_name
      FROM waiver_wire ww
      JOIN players p ON p.id = ww.player_id
      LEFT JOIN rosters r ON r.id = ww.dropped_by_roster_id
      WHERE ww.league_id = $1 AND ww.waiver_expires_at > NOW()
      ORDER BY ww.waiver_expires_at ASC`,
      [leagueId]
    );

    return result.rows.map(row => ({
      ...waiverWirePlayerFromDatabase(row),
      playerName: row.player_name || 'Unknown',
      playerPosition: row.player_position,
      playerTeam: row.player_team,
      droppedByTeamName: row.dropped_by_team_name,
    }));
  }

  /**
   * Clean up expired waiver wire entries
   */
  async removeExpired(client?: PoolClient): Promise<number> {
    const conn = client || this.db;
    const result = await conn.query(
      'DELETE FROM waiver_wire WHERE waiver_expires_at <= NOW()'
    );
    return result.rowCount ?? 0;
  }
}
