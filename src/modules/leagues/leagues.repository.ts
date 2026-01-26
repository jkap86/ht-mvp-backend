import { Pool, PoolClient } from 'pg';
import { League, Roster } from './leagues.model';

export interface CreateLeagueParams {
  name: string;
  season: string;
  totalRosters: number;
  settings?: Record<string, any>;
  scoringSettings?: Record<string, any>;
  mode?: string;
  leagueSettings?: Record<string, any>;
  isPublic?: boolean;
}

export class LeagueRepository {
  constructor(private readonly db: Pool) {}

  async findById(id: number): Promise<League | null> {
    const result = await this.db.query(
      'SELECT * FROM leagues WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return League.fromDatabase(result.rows[0]);
  }

  async findByInviteCode(inviteCode: string): Promise<League | null> {
    const result = await this.db.query(
      'SELECT * FROM leagues WHERE invite_code = $1',
      [inviteCode.toUpperCase()]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return League.fromDatabase(result.rows[0]);
  }

  async findByIdWithUserRoster(id: number, userId: string): Promise<League | null> {
    const result = await this.db.query(
      `SELECT l.*,
              r.roster_id as user_roster_id,
              (l.settings->>'commissioner_roster_id')::int as commissioner_roster_id
       FROM leagues l
       LEFT JOIN rosters r ON r.league_id = l.id AND r.user_id = $2
       WHERE l.id = $1`,
      [id, userId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return League.fromDatabase(result.rows[0]);
  }

  async findByUserId(userId: string, limit: number = 50, offset: number = 0): Promise<League[]> {
    const result = await this.db.query(
      `SELECT l.*,
              r.roster_id as user_roster_id,
              (l.settings->>'commissioner_roster_id')::int as commissioner_roster_id
       FROM leagues l
       INNER JOIN rosters r ON r.league_id = l.id
       WHERE r.user_id = $1
       ORDER BY l.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    return result.rows.map((row) => League.fromDatabase(row));
  }

  async create(params: CreateLeagueParams): Promise<League> {
    const result = await this.db.query(
      `INSERT INTO leagues (name, total_rosters, season, settings, scoring_settings, mode, league_settings, is_public)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        params.name,
        params.totalRosters,
        params.season,
        JSON.stringify(params.settings || {}),
        JSON.stringify(params.scoringSettings || {}),
        params.mode || 'redraft',
        JSON.stringify(params.leagueSettings || {}),
        params.isPublic || false,
      ]
    );

    return League.fromDatabase(result.rows[0]);
  }

  async update(id: number, updates: Partial<League>): Promise<League> {
    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.name) {
      setClauses.push(`name = $${paramIndex++}`);
      values.push(updates.name);
    }

    if (updates.status) {
      setClauses.push(`status = $${paramIndex++}`);
      values.push(updates.status);
    }

    if (updates.settings) {
      setClauses.push(`settings = COALESCE(settings, '{}'::jsonb) || $${paramIndex++}::jsonb`);
      values.push(JSON.stringify(updates.settings));
    }

    if (updates.scoringSettings) {
      setClauses.push(`scoring_settings = $${paramIndex++}`);
      values.push(JSON.stringify(updates.scoringSettings));
    }

    if (updates.mode) {
      setClauses.push(`mode = $${paramIndex++}`);
      values.push(updates.mode);
    }

    if (updates.leagueSettings) {
      setClauses.push(`league_settings = COALESCE(league_settings, '{}'::jsonb) || $${paramIndex++}::jsonb`);
      values.push(JSON.stringify(updates.leagueSettings));
    }

    if (updates.isPublic !== undefined) {
      setClauses.push(`is_public = $${paramIndex++}`);
      values.push(updates.isPublic);
    }

    if (setClauses.length === 0) {
      const existing = await this.findById(id);
      if (!existing) throw new Error('League not found');
      return existing;
    }

    values.push(id);

    const result = await this.db.query(
      `UPDATE leagues SET ${setClauses.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $${paramIndex}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      throw new Error('League not found');
    }

    return League.fromDatabase(result.rows[0]);
  }

  async delete(id: number): Promise<void> {
    await this.db.query('DELETE FROM leagues WHERE id = $1', [id]);
  }

  async isUserMember(leagueId: number, userId: string): Promise<boolean> {
    const result = await this.db.query(
      'SELECT EXISTS(SELECT 1 FROM rosters WHERE league_id = $1 AND user_id = $2)',
      [leagueId, userId]
    );
    return result.rows[0].exists;
  }

  async isCommissioner(leagueId: number, userId: string): Promise<boolean> {
    const result = await this.db.query(
      `SELECT l.settings->>'commissioner_roster_id' as commissioner_roster_id, r.roster_id
       FROM leagues l
       INNER JOIN rosters r ON r.league_id = l.id AND r.user_id = $2
       WHERE l.id = $1`,
      [leagueId, userId]
    );

    if (result.rows.length === 0) return false;

    const row = result.rows[0];
    if (!row.commissioner_roster_id || !row.roster_id) return false;
    return parseInt(row.commissioner_roster_id, 10) === row.roster_id;
  }

  async updateCommissionerRosterId(leagueId: number, rosterId: number): Promise<void> {
    await this.db.query(
      `UPDATE leagues
       SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{commissioner_roster_id}', to_jsonb($1::integer))
       WHERE id = $2`,
      [rosterId, leagueId]
    );
  }

  /**
   * Find public leagues that the user hasn't joined yet
   * Returns leagues with member count for discovery
   */
  async findPublicLeagues(userId: string, limit: number = 50, offset: number = 0): Promise<any[]> {
    const result = await this.db.query(
      `SELECT
        l.id,
        l.name,
        l.season,
        l.mode,
        l.total_rosters,
        l.is_public,
        COUNT(r.id) as member_count
       FROM leagues l
       LEFT JOIN rosters r ON r.league_id = l.id
       WHERE l.is_public = true
         AND NOT EXISTS (
           SELECT 1 FROM rosters r2
           WHERE r2.league_id = l.id AND r2.user_id = $1
         )
       GROUP BY l.id
       ORDER BY l.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    return result.rows.map(row => ({
      id: row.id,
      name: row.name,
      season: row.season,
      mode: row.mode,
      total_rosters: row.total_rosters,
      is_public: row.is_public,
      member_count: parseInt(row.member_count, 10),
    }));
  }
}

export class RosterRepository {
  constructor(private readonly db: Pool) {}

  async findByLeagueId(leagueId: number): Promise<Roster[]> {
    const result = await this.db.query(
      `SELECT r.*, u.username
       FROM rosters r
       LEFT JOIN users u ON r.user_id = u.id
       WHERE r.league_id = $1
       ORDER BY r.roster_id`,
      [leagueId]
    );

    return result.rows.map(row => ({
      id: row.id,
      leagueId: row.league_id,
      userId: row.user_id,
      rosterId: row.roster_id,
      settings: row.settings || {},
      starters: row.starters || [],
      bench: row.bench || [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      username: row.username,
    }));
  }

  async findByLeagueAndUser(
    leagueId: number,
    userId: string,
    client?: PoolClient
  ): Promise<Roster | null> {
    const db = client || this.db;
    const result = await db.query(
      'SELECT * FROM rosters WHERE league_id = $1 AND user_id = $2',
      [leagueId, userId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      leagueId: row.league_id,
      userId: row.user_id,
      rosterId: row.roster_id,
      settings: row.settings || {},
      starters: row.starters || [],
      bench: row.bench || [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async findById(id: number): Promise<Roster | null> {
    const result = await this.db.query(
      'SELECT * FROM rosters WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      leagueId: row.league_id,
      userId: row.user_id,
      rosterId: row.roster_id,
      settings: row.settings || {},
      starters: row.starters || [],
      bench: row.bench || [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
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

    const row = result.rows[0];
    return {
      id: row.id,
      leagueId: row.league_id,
      userId: row.user_id,
      rosterId: row.roster_id,
      settings: row.settings || {},
      starters: row.starters || [],
      bench: row.bench || [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
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
    const result = await db.query(
      'SELECT COUNT(*) as count FROM rosters WHERE league_id = $1',
      [leagueId]
    );
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Delete a roster by ID (used for kicking members)
   */
  async delete(rosterId: number, client?: PoolClient): Promise<boolean> {
    const db = client || this.db;
    const result = await db.query(
      'DELETE FROM rosters WHERE id = $1',
      [rosterId]
    );
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
}
