/**
 * Roster Repository
 *
 * Handles core roster entity operations including:
 * - Finding rosters by league/user
 * - Creating and managing roster slots
 * - Member management (bench, reinstate, delete)
 */

import type { Pool, PoolClient } from 'pg';
import type { Roster } from '../leagues/leagues.model';
import { RosterMapper } from '../../shared/mappers';

export class RosterRepository {
  constructor(private readonly db: Pool) {}

  async findByLeagueId(leagueId: number): Promise<Roster[]> {
    const result = await this.db.query(
      `SELECT r.*, u.username
       FROM rosters r
       LEFT JOIN users u ON r.user_id = u.id
       WHERE r.league_id = $1
       ORDER BY r.is_benched ASC, r.roster_id ASC`,
      [leagueId]
    );

    return RosterMapper.fromRows(result.rows);
  }

  /**
   * Get all rosters for a league AND verify user membership in a single query.
   * Returns null if the user is not a member.
   */
  async findByLeagueIdWithMembershipCheck(
    leagueId: number,
    userId: string
  ): Promise<(Roster & { teamName?: string })[] | null> {
    const result = await this.db.query(
      `WITH membership_check AS (
         SELECT EXISTS(SELECT 1 FROM rosters WHERE league_id = $1 AND user_id = $2) as is_member
       )
       SELECT r.*, u.username, mc.is_member,
              COALESCE(r.settings->>'team_name', u.username, 'Team ' || r.roster_id) as team_name
       FROM rosters r
       LEFT JOIN users u ON r.user_id = u.id
       CROSS JOIN membership_check mc
       WHERE r.league_id = $1
       ORDER BY r.is_benched ASC, r.roster_id ASC`,
      [leagueId, userId]
    );

    // If no rows returned, the league has no rosters or doesn't exist - still check membership
    if (result.rows.length === 0) {
      const memberCheck = await this.db.query(
        'SELECT EXISTS(SELECT 1 FROM rosters WHERE league_id = $1 AND user_id = $2) as is_member',
        [leagueId, userId]
      );
      return memberCheck.rows[0]?.is_member ? [] : null;
    }

    // Check membership from the first row
    if (!result.rows[0].is_member) {
      return null;
    }

    return result.rows.map((row) => ({
      ...RosterMapper.fromRow(row),
      teamName: row.team_name,
    }));
  }

  async findByLeagueAndUser(
    leagueId: number,
    userId: string,
    client?: PoolClient
  ): Promise<Roster | null> {
    const db = client || this.db;
    const result = await db.query('SELECT * FROM rosters WHERE league_id = $1 AND user_id = $2', [
      leagueId,
      userId,
    ]);

    if (result.rows.length === 0) return null;
    return RosterMapper.fromRow(result.rows[0]);
  }

  async findById(id: number): Promise<Roster | null> {
    const result = await this.db.query('SELECT * FROM rosters WHERE id = $1', [id]);

    if (result.rows.length === 0) return null;
    return RosterMapper.fromRow(result.rows[0]);
  }

  /**
   * Find roster by league ID and per-league roster_id (not global id)
   */
  async findByLeagueAndRosterId(leagueId: number, rosterId: number): Promise<Roster | null> {
    const result = await this.db.query(
      'SELECT * FROM rosters WHERE league_id = $1 AND roster_id = $2',
      [leagueId, rosterId]
    );

    if (result.rows.length === 0) return null;
    return RosterMapper.fromRow(result.rows[0]);
  }

  async create(
    leagueId: number,
    userId: string,
    rosterId: number,
    client?: PoolClient
  ): Promise<Roster> {
    const db = client || this.db;
    const result = await db.query(
      `INSERT INTO rosters (league_id, user_id, roster_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [leagueId, userId, rosterId]
    );

    return RosterMapper.fromRow(result.rows[0]);
  }

  async getNextRosterId(leagueId: number, client?: PoolClient): Promise<number> {
    const db = client || this.db;
    const result = await db.query(
      'SELECT COALESCE(MAX(roster_id), 0) + 1 as next_id FROM rosters WHERE league_id = $1',
      [leagueId]
    );
    return result.rows[0].next_id;
  }

  async getRosterCount(leagueId: number, client?: PoolClient): Promise<number> {
    const db = client || this.db;
    // Only count rosters with actual users (exclude empty roster slots)
    const result = await db.query(
      'SELECT COUNT(*) as count FROM rosters WHERE league_id = $1 AND is_benched = false AND user_id IS NOT NULL',
      [leagueId]
    );
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Get total roster count including benched members
   */
  async getTotalRosterCount(leagueId: number, client?: PoolClient): Promise<number> {
    const db = client || this.db;
    const result = await db.query('SELECT COUNT(*) as count FROM rosters WHERE league_id = $1', [
      leagueId,
    ]);
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Bench a member (set is_benched = true)
   */
  async benchMember(rosterId: number, client?: PoolClient): Promise<void> {
    const db = client || this.db;
    await db.query(
      'UPDATE rosters SET is_benched = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [rosterId]
    );
  }

  /**
   * Reinstate a benched member (set is_benched = false)
   */
  async reinstateMember(rosterId: number, client?: PoolClient): Promise<void> {
    const db = client || this.db;
    await db.query(
      'UPDATE rosters SET is_benched = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [rosterId]
    );
  }

  /**
   * Get newest members (excluding commissioner) for benching when reducing team count
   */
  async getNewestMembers(
    leagueId: number,
    count: number,
    excludeRosterId: number,
    client?: PoolClient
  ): Promise<Roster[]> {
    const db = client || this.db;
    const result = await db.query(
      `SELECT r.*, u.username
       FROM rosters r
       LEFT JOIN users u ON r.user_id = u.id
       WHERE r.league_id = $1
         AND r.roster_id != $2
         AND r.is_benched = false
       ORDER BY r.created_at DESC
       LIMIT $3`,
      [leagueId, excludeRosterId, count]
    );

    return RosterMapper.fromRows(result.rows);
  }

  /**
   * Delete a roster by ID (used for kicking members)
   */
  async delete(rosterId: number, client?: PoolClient): Promise<boolean> {
    const db = client || this.db;
    const result = await db.query('DELETE FROM rosters WHERE id = $1', [rosterId]);
    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Get team name for a roster
   */
  async getTeamName(rosterId: number): Promise<string | null> {
    const result = await this.db.query(
      `SELECT COALESCE(r.settings->>'team_name', u.username, 'Team ' || r.roster_id) as team_name
       FROM rosters r
       LEFT JOIN users u ON r.user_id = u.id
       WHERE r.id = $1`,
      [rosterId]
    );
    if (result.rows.length === 0) return null;
    return result.rows[0].team_name;
  }

  /**
   * Delete all empty rosters (no user assigned) for a league.
   */
  async deleteEmptyRosters(leagueId: number, client?: PoolClient): Promise<void> {
    const db = client || this.db;
    await db.query(
      'DELETE FROM rosters WHERE league_id = $1 AND user_id IS NULL',
      [leagueId]
    );
  }

  /**
   * Create an empty roster (no user assigned) for unfilled league slots.
   */
  async createEmptyRoster(
    leagueId: number,
    rosterId: number,
    client?: PoolClient
  ): Promise<Roster> {
    const db = client || this.db;
    const result = await db.query(
      `INSERT INTO rosters (league_id, user_id, roster_id)
       VALUES ($1, NULL, $2)
       RETURNING *`,
      [leagueId, rosterId]
    );

    return RosterMapper.fromRow(result.rows[0]);
  }

  /**
   * Find an empty roster (no user assigned) in the league.
   */
  async findEmptyRoster(leagueId: number, client?: PoolClient): Promise<Roster | null> {
    const db = client || this.db;
    const result = await db.query(
      `SELECT * FROM rosters WHERE league_id = $1 AND user_id IS NULL ORDER BY roster_id LIMIT 1`,
      [leagueId]
    );

    if (result.rows.length === 0) return null;
    return RosterMapper.fromRow(result.rows[0]);
  }

  /**
   * Assign a user to an existing empty roster.
   */
  async assignUserToRoster(rosterId: number, userId: string, client?: PoolClient): Promise<Roster> {
    const db = client || this.db;
    const result = await db.query(
      `UPDATE rosters SET user_id = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id IS NULL
       RETURNING *`,
      [rosterId, userId]
    );

    if (result.rows.length === 0) {
      throw new Error('Roster not found or already has a user assigned');
    }

    return RosterMapper.fromRow(result.rows[0]);
  }
}
