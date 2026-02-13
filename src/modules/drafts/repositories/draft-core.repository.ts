/**
 * Draft Core Repository
 *
 * Handles core draft CRUD operations and queries.
 */

import type { Pool, PoolClient } from 'pg';
import type { Draft, DraftSettings } from '../drafts.model';
import { draftFromDatabase } from '../drafts.model';
import { buildUpdateQuery } from '../../../shared/query-builder';
import { runWithLock, LockDomain } from '../../../shared/transaction-runner';
import { ConflictException } from '../../../utils/exceptions';

export class DraftCoreRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Find a draft by ID.
   */
  async findById(id: number): Promise<Draft | null> {
    const result = await this.db.query('SELECT * FROM drafts WHERE id = $1', [id]);
    return result.rows.length > 0 ? draftFromDatabase(result.rows[0]) : null;
  }

  /**
   * Find a draft by ID using an existing client (for use within transactions).
   */
  async findByIdWithClient(client: PoolClient, id: number): Promise<Draft | null> {
    const result = await client.query('SELECT * FROM drafts WHERE id = $1', [id]);
    return result.rows.length > 0 ? draftFromDatabase(result.rows[0]) : null;
  }

  /**
   * Find all drafts for a league.
   */
  async findByLeagueId(leagueId: number, leagueSeasonId?: number): Promise<Draft[]> {
    const filter = leagueSeasonId ? 'league_season_id = $1' : 'league_id = $1';
    const result = await this.db.query(
      `SELECT * FROM drafts WHERE ${filter} ORDER BY CASE WHEN scheduled_start IS NULL THEN 1 ELSE 0 END, scheduled_start ASC NULLS LAST, created_at DESC`,
      [leagueSeasonId || leagueId]
    );
    return result.rows.map(draftFromDatabase);
  }

  /**
   * Get all drafts for a league AND verify user membership in a single query.
   * Returns null if the user is not a member.
   */
  async findByLeagueIdWithMembershipCheck(
    leagueId: number,
    userId: string,
    leagueSeasonId?: number
  ): Promise<Draft[] | null> {
    const draftFilter = leagueSeasonId
      ? 'd.league_season_id = $3'
      : 'd.league_id = $1';
    const params: any[] = [leagueId, userId];
    if (leagueSeasonId) params.push(leagueSeasonId);

    const result = await this.db.query(
      `WITH membership_check AS (
         SELECT EXISTS(SELECT 1 FROM rosters WHERE league_id = $1 AND user_id = $2) as is_member
       )
       SELECT d.*, mc.is_member
       FROM drafts d
       CROSS JOIN membership_check mc
       WHERE ${draftFilter}
       ORDER BY CASE WHEN d.scheduled_start IS NULL THEN 1 ELSE 0 END, d.scheduled_start ASC NULLS LAST, d.created_at DESC`,
      params
    );

    // If no drafts exist, still check membership
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

    return result.rows.map(draftFromDatabase);
  }

  /**
   * Create a new draft.
   */
  async create(
    leagueId: number,
    draftType: string,
    rounds: number,
    pickTimeSeconds: number,
    settings?: DraftSettings,
    scheduledStart?: Date,
    leagueSeasonId?: number
  ): Promise<Draft> {
    const result = await this.db.query(
      `INSERT INTO drafts (league_id, draft_type, rounds, pick_time_seconds, settings, scheduled_start, league_season_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [leagueId, draftType, rounds, pickTimeSeconds, settings ? JSON.stringify(settings) : null, scheduledStart || null, leagueSeasonId || null]
    );
    return draftFromDatabase(result.rows[0]);
  }

  /**
   * Create a new draft within an existing transaction.
   */
  async createWithClient(
    client: PoolClient,
    leagueId: number,
    draftType: string,
    rounds: number,
    pickTimeSeconds: number,
    settings?: DraftSettings,
    scheduledStart?: Date,
    leagueSeasonId?: number
  ): Promise<Draft> {
    const result = await client.query(
      `INSERT INTO drafts (league_id, draft_type, rounds, pick_time_seconds, settings, scheduled_start, league_season_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [leagueId, draftType, rounds, pickTimeSeconds, settings ? JSON.stringify(settings) : null, scheduledStart || null, leagueSeasonId || null]
    );
    return draftFromDatabase(result.rows[0]);
  }

  /**
   * Update a draft with partial updates.
   */
  async update(id: number, updates: Partial<Draft>): Promise<Draft> {
    // Convert complex types to JSON strings
    const dbUpdates: Record<string, any> = {};

    if (updates.status !== undefined) dbUpdates.status = updates.status;
    if (updates.currentPick !== undefined) dbUpdates.currentPick = updates.currentPick;
    if (updates.currentRound !== undefined) dbUpdates.currentRound = updates.currentRound;
    if (updates.currentRosterId !== undefined) dbUpdates.currentRosterId = updates.currentRosterId;
    if (updates.pickDeadline !== undefined) dbUpdates.pickDeadline = updates.pickDeadline;
    if (updates.startedAt !== undefined) dbUpdates.startedAt = updates.startedAt;
    if (updates.completedAt !== undefined) dbUpdates.completedAt = updates.completedAt;
    if (updates.draftState !== undefined) dbUpdates.draftState = JSON.stringify(updates.draftState);
    if (updates.settings !== undefined) dbUpdates.settings = JSON.stringify(updates.settings);
    if (updates.rounds !== undefined) dbUpdates.rounds = updates.rounds;
    if (updates.pickTimeSeconds !== undefined) dbUpdates.pickTimeSeconds = updates.pickTimeSeconds;
    if (updates.draftType !== undefined) dbUpdates.draftType = updates.draftType;
    if (updates.scheduledStart !== undefined) dbUpdates.scheduledStart = updates.scheduledStart;
    if (updates.rosterPopulationStatus !== undefined) dbUpdates.rosterPopulationStatus = updates.rosterPopulationStatus;
    if (updates.overnightPauseEnabled !== undefined) dbUpdates.overnightPauseEnabled = updates.overnightPauseEnabled;
    if (updates.overnightPauseStart !== undefined) dbUpdates.overnightPauseStart = updates.overnightPauseStart;
    if (updates.overnightPauseEnd !== undefined) dbUpdates.overnightPauseEnd = updates.overnightPauseEnd;

    if (Object.keys(dbUpdates).length === 0) {
      const existing = await this.findById(id);
      if (!existing) throw new Error('Draft not found');
      return existing;
    }

    const { query, values } = buildUpdateQuery('drafts', dbUpdates, 'id', id);
    const result = await this.db.query(query, values);

    return draftFromDatabase(result.rows[0]);
  }

  /**
   * Update a draft with partial updates while holding an advisory lock.
   * Optionally validates expected status before updating.
   * Use this for state transitions that need to be atomic and prevent races.
   */
  async updateWithLock(
    id: number,
    updates: Partial<Draft>,
    expectedStatus?: string
  ): Promise<Draft> {
    return runWithLock(this.db, LockDomain.DRAFT, id, async (client) => {
      // Validate expected status if provided
      if (expectedStatus) {
        const current = await client.query('SELECT status FROM drafts WHERE id = $1 FOR UPDATE', [id]);
        if (current.rows.length === 0) {
          throw new ConflictException('Draft not found');
        }
        if (current.rows[0].status !== expectedStatus) {
          throw new ConflictException(`Draft status is not ${expectedStatus}`);
        }
      }

      // Convert complex types to JSON strings
      const dbUpdates: Record<string, any> = {};

      if (updates.status !== undefined) dbUpdates.status = updates.status;
      if (updates.currentPick !== undefined) dbUpdates.currentPick = updates.currentPick;
      if (updates.currentRound !== undefined) dbUpdates.currentRound = updates.currentRound;
      if (updates.currentRosterId !== undefined) dbUpdates.currentRosterId = updates.currentRosterId;
      if (updates.pickDeadline !== undefined) dbUpdates.pickDeadline = updates.pickDeadline;
      if (updates.startedAt !== undefined) dbUpdates.startedAt = updates.startedAt;
      if (updates.completedAt !== undefined) dbUpdates.completedAt = updates.completedAt;
      if (updates.draftState !== undefined) dbUpdates.draftState = JSON.stringify(updates.draftState);
      if (updates.settings !== undefined) dbUpdates.settings = JSON.stringify(updates.settings);
      if (updates.rounds !== undefined) dbUpdates.rounds = updates.rounds;
      if (updates.pickTimeSeconds !== undefined) dbUpdates.pickTimeSeconds = updates.pickTimeSeconds;
      if (updates.draftType !== undefined) dbUpdates.draftType = updates.draftType;
      if (updates.scheduledStart !== undefined) dbUpdates.scheduledStart = updates.scheduledStart;
      if (updates.rosterPopulationStatus !== undefined) dbUpdates.rosterPopulationStatus = updates.rosterPopulationStatus;

      if (Object.keys(dbUpdates).length === 0) {
        const existing = await this.findByIdWithClient(client, id);
        if (!existing) throw new ConflictException('Draft not found');
        return existing;
      }

      const { query, values } = buildUpdateQuery('drafts', dbUpdates, 'id', id);
      const result = await client.query(query, values);

      return draftFromDatabase(result.rows[0]);
    });
  }

  /**
   * Update a draft within an existing transaction.
   * Use this when you already have a PoolClient and need to update draft state.
   */
  async updateWithClient(
    client: PoolClient,
    id: number,
    updates: Partial<Draft>
  ): Promise<Draft> {
    // Convert complex types to JSON strings
    const dbUpdates: Record<string, any> = {};

    if (updates.status !== undefined) dbUpdates.status = updates.status;
    if (updates.currentPick !== undefined) dbUpdates.currentPick = updates.currentPick;
    if (updates.currentRound !== undefined) dbUpdates.currentRound = updates.currentRound;
    if (updates.currentRosterId !== undefined) dbUpdates.currentRosterId = updates.currentRosterId;
    if (updates.pickDeadline !== undefined) dbUpdates.pickDeadline = updates.pickDeadline;
    if (updates.startedAt !== undefined) dbUpdates.startedAt = updates.startedAt;
    if (updates.completedAt !== undefined) dbUpdates.completedAt = updates.completedAt;
    if (updates.draftState !== undefined) dbUpdates.draftState = JSON.stringify(updates.draftState);
    if (updates.settings !== undefined) dbUpdates.settings = JSON.stringify(updates.settings);
    if (updates.rounds !== undefined) dbUpdates.rounds = updates.rounds;
    if (updates.pickTimeSeconds !== undefined) dbUpdates.pickTimeSeconds = updates.pickTimeSeconds;
    if (updates.draftType !== undefined) dbUpdates.draftType = updates.draftType;
    if (updates.scheduledStart !== undefined) dbUpdates.scheduledStart = updates.scheduledStart;
    if (updates.rosterPopulationStatus !== undefined) dbUpdates.rosterPopulationStatus = updates.rosterPopulationStatus;
    if (updates.overnightPauseEnabled !== undefined) dbUpdates.overnightPauseEnabled = updates.overnightPauseEnabled;
    if (updates.overnightPauseStart !== undefined) dbUpdates.overnightPauseStart = updates.overnightPauseStart;
    if (updates.overnightPauseEnd !== undefined) dbUpdates.overnightPauseEnd = updates.overnightPauseEnd;

    if (Object.keys(dbUpdates).length === 0) {
      const existing = await this.findByIdWithClient(client, id);
      if (!existing) throw new Error('Draft not found');
      return existing;
    }

    const { query, values } = buildUpdateQuery('drafts', dbUpdates, 'id', id);
    const result = await client.query(query, values);

    return draftFromDatabase(result.rows[0]);
  }

  /**
   * Delete a draft.
   */
  async delete(id: number): Promise<void> {
    await this.db.query('DELETE FROM drafts WHERE id = $1', [id]);
  }

  /**
   * Set the order confirmed flag.
   */
  async setOrderConfirmed(draftId: number, confirmed: boolean): Promise<void> {
    await this.db.query(
      'UPDATE drafts SET order_confirmed = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [confirmed, draftId]
    );
  }

  /**
   * Find drafts that need autopick processing.
   */
  async findExpiredDrafts(): Promise<Draft[]> {
    const result = await this.db.query(
      `SELECT d.* FROM drafts d
       WHERE d.status = 'in_progress'
       AND (
         (d.pick_deadline IS NOT NULL AND d.pick_deadline < NOW())
         OR EXISTS (
           SELECT 1 FROM draft_order dord
           WHERE dord.draft_id = d.id
           AND dord.roster_id = d.current_roster_id
           AND dord.is_autodraft_enabled = true
         )
         OR EXISTS (
           SELECT 1 FROM rosters r
           WHERE r.id = d.current_roster_id
           AND r.user_id IS NULL
         )
       )`
    );
    return result.rows.map(draftFromDatabase);
  }

  /**
   * Find drafts with a specific status and overnight pause enabled.
   * Used to check for overnight pause window transitions.
   */
  async findByStatusAndOvernightPauseEnabled(status: string): Promise<Draft[]> {
    const result = await this.db.query(
      `SELECT * FROM drafts
       WHERE status = $1
       AND overnight_pause_enabled = true
       AND overnight_pause_start IS NOT NULL
       AND overnight_pause_end IS NOT NULL`,
      [status]
    );
    return result.rows.map(draftFromDatabase);
  }

  /**
   * Get best available player for autopick.
   * Ranks by ADP (average draft position) with player id as tiebreaker.
   * Respects playerPool filtering and only considers active players.
   */
  async getBestAvailablePlayer(
    draftId: number,
    playerPool: string[] = ['veteran', 'rookie']
  ): Promise<number | null> {
    // Build WHERE clause based on playerPool
    const conditions: string[] = [];
    if (playerPool.includes('veteran')) {
      conditions.push("(p.player_type = 'nfl' AND (p.years_exp > 0 OR p.years_exp IS NULL))");
    }
    if (playerPool.includes('rookie')) {
      conditions.push("(p.player_type = 'nfl' AND p.years_exp = 0)");
    }
    if (playerPool.includes('college')) {
      conditions.push("(p.player_type = 'college')");
    }

    const playerFilter = conditions.length > 0
      ? `AND (${conditions.join(' OR ')})`
      : '';

    const result = await this.db.query(
      `SELECT p.id FROM players p
       WHERE p.active = true
       ${playerFilter}
       AND NOT EXISTS (SELECT 1 FROM draft_picks dp WHERE dp.draft_id = $1 AND dp.player_id = p.id)
       ORDER BY p.adp ASC NULLS LAST, p.id ASC
       LIMIT 1`,
      [draftId]
    );
    return result.rows.length > 0 ? result.rows[0].id : null;
  }

  /**
   * Get best available player for autopick using an existing client (for transactions).
   * Ranks by ADP (average draft position) with player id as tiebreaker.
   * Respects playerPool filtering and only considers active players.
   */
  async getBestAvailablePlayerWithClient(
    client: PoolClient,
    draftId: number,
    playerPool: string[] = ['veteran', 'rookie']
  ): Promise<number | null> {
    // Build WHERE clause based on playerPool
    const conditions: string[] = [];
    if (playerPool.includes('veteran')) {
      conditions.push("(p.player_type = 'nfl' AND (p.years_exp > 0 OR p.years_exp IS NULL))");
    }
    if (playerPool.includes('rookie')) {
      conditions.push("(p.player_type = 'nfl' AND p.years_exp = 0)");
    }
    if (playerPool.includes('college')) {
      conditions.push("(p.player_type = 'college')");
    }

    const playerFilter = conditions.length > 0
      ? `AND (${conditions.join(' OR ')})`
      : '';

    const result = await client.query(
      `SELECT p.id FROM players p
       WHERE p.active = true
       ${playerFilter}
       AND NOT EXISTS (SELECT 1 FROM draft_picks dp WHERE dp.draft_id = $1 AND dp.player_id = p.id)
       ORDER BY p.adp ASC NULLS LAST, p.id ASC
       LIMIT 1`,
      [draftId]
    );
    return result.rows.length > 0 ? result.rows[0].id : null;
  }
}
