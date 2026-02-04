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
    const result = await this.db.query('SELECT * FROM leagues WHERE id = $1', [id]);

    if (result.rows.length === 0) {
      return null;
    }

    return League.fromDatabase(result.rows[0]);
  }

  async findByInviteCode(inviteCode: string): Promise<League | null> {
    const result = await this.db.query('SELECT * FROM leagues WHERE invite_code = $1', [
      inviteCode.toUpperCase(),
    ]);

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
      setClauses.push(
        `league_settings = COALESCE(league_settings, '{}'::jsonb) || $${paramIndex++}::jsonb`
      );
      values.push(JSON.stringify(updates.leagueSettings));
    }

    if (updates.isPublic !== undefined) {
      setClauses.push(`is_public = $${paramIndex++}`);
      values.push(updates.isPublic);
    }

    if (updates.totalRosters !== undefined) {
      setClauses.push(`total_rosters = $${paramIndex++}`);
      values.push(updates.totalRosters);
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

  async resetForNewSeason(
    leagueId: number,
    newSeason: string,
    options: { keepMembers?: boolean; clearChat?: boolean }
  ): Promise<League> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // Lock the league to prevent concurrent modifications
      await client.query('SELECT pg_advisory_xact_lock($1)', [leagueId]);

      // Clear season data (CASCADE handles child tables)
      await client.query('DELETE FROM drafts WHERE league_id = $1', [leagueId]);
      await client.query('DELETE FROM matchups WHERE league_id = $1', [leagueId]);
      await client.query('DELETE FROM trades WHERE league_id = $1', [leagueId]);
      await client.query('DELETE FROM waiver_claims WHERE league_id = $1', [leagueId]);
      await client.query('DELETE FROM waiver_wire WHERE league_id = $1', [leagueId]);
      await client.query('DELETE FROM waiver_priority WHERE league_id = $1', [leagueId]);
      await client.query('DELETE FROM faab_budgets WHERE league_id = $1', [leagueId]);
      await client.query('DELETE FROM playoff_brackets WHERE league_id = $1', [leagueId]);
      await client.query('DELETE FROM roster_transactions WHERE league_id = $1', [leagueId]);

      // Clear roster player data
      await client.query(
        `
        DELETE FROM roster_players WHERE roster_id IN
        (SELECT id FROM rosters WHERE league_id = $1)
      `,
        [leagueId]
      );
      await client.query(
        `
        DELETE FROM roster_lineups WHERE roster_id IN
        (SELECT id FROM rosters WHERE league_id = $1)
      `,
        [leagueId]
      );

      // Optionally clear chat
      if (options.clearChat !== false) {
        await client.query('DELETE FROM league_chat_messages WHERE league_id = $1', [leagueId]);
      }

      // Get commissioner roster ID from league settings
      const leagueResult = await client.query(
        `SELECT settings->>'commissioner_roster_id' as commissioner_roster_id FROM leagues WHERE id = $1`,
        [leagueId]
      );
      const commissionerRosterId = leagueResult.rows[0]?.commissioner_roster_id
        ? parseInt(leagueResult.rows[0].commissioner_roster_id, 10)
        : null;

      // Clear or reset rosters (always preserve commissioner)
      if (!options.keepMembers) {
        // Delete all rosters EXCEPT the commissioner
        if (commissionerRosterId) {
          await client.query('DELETE FROM rosters WHERE league_id = $1 AND id != $2', [
            leagueId,
            commissionerRosterId,
          ]);
        } else {
          await client.query('DELETE FROM rosters WHERE league_id = $1', [leagueId]);
        }
      }

      // Always reset roster data for remaining rosters
      await client.query(
        `
        UPDATE rosters SET starters = '[]', bench = '[]', updated_at = CURRENT_TIMESTAMP
        WHERE league_id = $1
      `,
        [leagueId]
      );

      // Update league for new season
      const result = await client.query(
        `
        UPDATE leagues SET
          season = $2,
          season_status = 'pre_season',
          current_week = 1,
          status = 'pre_draft',
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *
      `,
        [leagueId, newSeason]
      );

      await client.query('COMMIT');
      return League.fromDatabase(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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
   * Check if league mode can be changed.
   * Mode can only be changed when:
   * 1. All drafts have status 'not_started'
   * 2. No players are on any roster in the league
   */
  async canChangeLeagueMode(leagueId: number): Promise<{ allowed: boolean; reason?: string }> {
    // Check 1: All drafts must be 'not_started'
    const draftResult = await this.db.query(
      `SELECT COUNT(*) as count FROM drafts
       WHERE league_id = $1 AND status != 'not_started'`,
      [leagueId]
    );

    if (parseInt(draftResult.rows[0].count, 10) > 0) {
      return {
        allowed: false,
        reason: 'League mode cannot be changed after a draft has started',
      };
    }

    // Check 2: No players on any roster
    const rosterPlayersResult = await this.db.query(
      `SELECT COUNT(*) as count FROM roster_players rp
       JOIN rosters r ON rp.roster_id = r.id
       WHERE r.league_id = $1`,
      [leagueId]
    );

    if (parseInt(rosterPlayersResult.rows[0].count, 10) > 0) {
      return {
        allowed: false,
        reason: 'League mode cannot be changed after players have been added to rosters',
      };
    }

    return { allowed: true };
  }

  /**
   * Find public leagues that the user hasn't joined yet
   * Returns leagues with member count, dues info, and fill status for discovery
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
        COUNT(DISTINCT r.user_id) FILTER (WHERE r.is_benched = false) as member_count,
        CASE WHEN ld.id IS NOT NULL THEN true ELSE false END as has_dues,
        ld.buy_in_amount,
        ld.currency,
        COALESCE(COUNT(DISTINCT dp.roster_id) FILTER (WHERE dp.is_paid = true), 0) as paid_count
       FROM leagues l
       LEFT JOIN rosters r ON r.league_id = l.id AND r.user_id IS NOT NULL
       LEFT JOIN league_dues ld ON ld.league_id = l.id
       LEFT JOIN dues_payments dp ON dp.league_id = l.id
         AND dp.roster_id IN (SELECT id FROM rosters WHERE league_id = l.id AND is_benched = false)
       WHERE l.is_public = true
         AND NOT EXISTS (
           SELECT 1 FROM rosters r2
           WHERE r2.league_id = l.id AND r2.user_id = $1
         )
       GROUP BY l.id, ld.id, ld.buy_in_amount, ld.currency
       ORDER BY l.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    return result.rows.map((row) => {
      const memberCount = parseInt(row.member_count, 10);
      const totalRosters = row.total_rosters;
      const hasDues = row.has_dues;
      const paidCount = parseInt(row.paid_count, 10);

      return {
        id: row.id,
        name: row.name,
        season: row.season,
        mode: row.mode,
        total_rosters: totalRosters,
        is_public: row.is_public,
        member_count: memberCount,
        has_dues: hasDues,
        buy_in_amount: row.buy_in_amount ? parseFloat(row.buy_in_amount) : null,
        currency: row.currency || null,
        paid_count: paidCount,
        fill_status: this.computeFillStatus(memberCount, totalRosters, hasDues, paidCount),
      };
    });
  }

  /**
   * Compute fill status for a league
   * - 'open': Slots available
   * - 'waiting_payment': Paid league at capacity but not all paid
   * - 'filled': Free league full, OR paid league with all paid
   */
  private computeFillStatus(
    memberCount: number,
    totalRosters: number,
    hasDues: boolean,
    paidCount: number
  ): 'open' | 'waiting_payment' | 'filled' {
    // Slots still available
    if (memberCount < totalRosters) {
      return 'open';
    }

    // League at capacity
    if (hasDues) {
      // Paid league - check if all members have paid
      if (paidCount >= memberCount) {
        return 'filled';
      }
      // Not all paid - can join as bench
      return 'waiting_payment';
    }

    // Free league at capacity
    return 'filled';
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
       ORDER BY r.is_benched ASC, r.roster_id ASC`,
      [leagueId]
    );

    return result.rows.map((row) => ({
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
      isBenched: row.is_benched || false,
    }));
  }

  /**
   * Get all rosters for a league AND verify user membership in a single query.
   * Returns null if the user is not a member (avoids race condition with separate isUserMember check).
   */
  async findByLeagueIdWithMembershipCheck(
    leagueId: number,
    userId: string
  ): Promise<Roster[] | null> {
    const result = await this.db.query(
      `WITH membership_check AS (
         SELECT EXISTS(SELECT 1 FROM rosters WHERE league_id = $1 AND user_id = $2) as is_member
       )
       SELECT r.*, u.username, mc.is_member
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
      isBenched: row.is_benched || false,
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
      isBenched: row.is_benched || false,
    };
  }

  async findById(id: number): Promise<Roster | null> {
    const result = await this.db.query('SELECT * FROM rosters WHERE id = $1', [id]);

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
      isBenched: row.is_benched || false,
    };
  }

  /**
   * Find roster by league ID and per-league roster_id (not global id)
   * This is used when the URL contains roster_id (1, 2, 3...) not the global PK
   */
  async findByLeagueAndRosterId(leagueId: number, rosterId: number): Promise<Roster | null> {
    const result = await this.db.query(
      'SELECT * FROM rosters WHERE league_id = $1 AND roster_id = $2',
      [leagueId, rosterId]
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
      isBenched: row.is_benched || false,
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
      isBenched: row.is_benched || false,
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
    // Only count active (non-benched) members
    const result = await db.query(
      'SELECT COUNT(*) as count FROM rosters WHERE league_id = $1 AND is_benched = false',
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
   * Returns members sorted by created_at DESC (newest first)
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

    return result.rows.map((row) => ({
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
      isBenched: row.is_benched || false,
    }));
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
   * Create an empty roster (no user assigned) for unfilled league slots.
   * Used when randomizing draft order to include all roster positions.
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
      isBenched: row.is_benched || false,
    };
  }

  /**
   * Find an empty roster (no user assigned) in the league.
   * Used when a user joins a league that already has randomized draft order.
   */
  async findEmptyRoster(leagueId: number, client?: PoolClient): Promise<Roster | null> {
    const db = client || this.db;
    const result = await db.query(
      `SELECT * FROM rosters WHERE league_id = $1 AND user_id IS NULL ORDER BY roster_id LIMIT 1`,
      [leagueId]
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
      isBenched: row.is_benched || false,
    };
  }

  /**
   * Assign a user to an existing empty roster.
   * Used when a user joins a league that already has randomized draft order.
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
      isBenched: row.is_benched || false,
    };
  }
}
