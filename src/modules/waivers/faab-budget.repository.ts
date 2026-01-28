import { Pool, PoolClient } from 'pg';
import {
  FaabBudget,
  FaabBudgetWithDetails,
  faabBudgetFromDatabase,
} from './waivers.model';

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
        u.username as username
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
