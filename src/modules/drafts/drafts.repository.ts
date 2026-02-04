import { Pool } from 'pg';
import { Draft, DraftOrderEntry, DraftPick, draftFromDatabase } from './drafts.model';
import { ConflictException } from '../../utils/exceptions';
import { getDraftLockId } from '../../utils/locks';

export class DraftRepository {
  constructor(private readonly db: Pool) {}

  async findById(id: number): Promise<Draft | null> {
    const result = await this.db.query('SELECT * FROM drafts WHERE id = $1', [id]);
    return result.rows.length > 0 ? draftFromDatabase(result.rows[0]) : null;
  }

  async findByLeagueId(leagueId: number): Promise<Draft[]> {
    const result = await this.db.query(
      'SELECT * FROM drafts WHERE league_id = $1 ORDER BY CASE WHEN scheduled_start IS NULL THEN 1 ELSE 0 END, scheduled_start ASC NULLS LAST, created_at DESC',
      [leagueId]
    );
    return result.rows.map(draftFromDatabase);
  }

  /**
   * Get all drafts for a league AND verify user membership in a single query.
   * Returns null if the user is not a member (avoids race condition with separate isUserMember check).
   */
  async findByLeagueIdWithMembershipCheck(
    leagueId: number,
    userId: string
  ): Promise<Draft[] | null> {
    const result = await this.db.query(
      `WITH membership_check AS (
         SELECT EXISTS(SELECT 1 FROM rosters WHERE league_id = $1 AND user_id = $2) as is_member
       )
       SELECT d.*, mc.is_member
       FROM drafts d
       CROSS JOIN membership_check mc
       WHERE d.league_id = $1
       ORDER BY CASE WHEN d.scheduled_start IS NULL THEN 1 ELSE 0 END, d.scheduled_start ASC NULLS LAST, d.created_at DESC`,
      [leagueId, userId]
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

  async create(
    leagueId: number,
    draftType: string,
    rounds: number,
    pickTimeSeconds: number,
    settings?: Record<string, any>,
    scheduledStart?: Date
  ): Promise<Draft> {
    const result = await this.db.query(
      `INSERT INTO drafts (league_id, draft_type, rounds, pick_time_seconds, settings, scheduled_start)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [leagueId, draftType, rounds, pickTimeSeconds, settings ? JSON.stringify(settings) : null, scheduledStart || null]
    );
    return draftFromDatabase(result.rows[0]);
  }

  async update(id: number, updates: Partial<Draft>): Promise<Draft> {
    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.status) {
      setClauses.push(`status = $${paramIndex++}`);
      values.push(updates.status);
    }
    if (updates.currentPick !== undefined) {
      setClauses.push(`current_pick = $${paramIndex++}`);
      values.push(updates.currentPick);
    }
    if (updates.currentRound !== undefined) {
      setClauses.push(`current_round = $${paramIndex++}`);
      values.push(updates.currentRound);
    }
    if (updates.currentRosterId !== undefined) {
      setClauses.push(`current_roster_id = $${paramIndex++}`);
      values.push(updates.currentRosterId);
    }
    if (updates.pickDeadline !== undefined) {
      setClauses.push(`pick_deadline = $${paramIndex++}`);
      values.push(updates.pickDeadline);
    }
    if (updates.startedAt !== undefined) {
      setClauses.push(`started_at = $${paramIndex++}`);
      values.push(updates.startedAt);
    }
    if (updates.completedAt !== undefined) {
      setClauses.push(`completed_at = $${paramIndex++}`);
      values.push(updates.completedAt);
    }
    if (updates.draftState !== undefined) {
      setClauses.push(`draft_state = $${paramIndex++}`);
      values.push(JSON.stringify(updates.draftState));
    }
    if (updates.settings !== undefined) {
      setClauses.push(`settings = $${paramIndex++}`);
      values.push(JSON.stringify(updates.settings));
    }
    if (updates.rounds !== undefined) {
      setClauses.push(`rounds = $${paramIndex++}`);
      values.push(updates.rounds);
    }
    if (updates.pickTimeSeconds !== undefined) {
      setClauses.push(`pick_time_seconds = $${paramIndex++}`);
      values.push(updates.pickTimeSeconds);
    }
    if (updates.draftType !== undefined) {
      setClauses.push(`draft_type = $${paramIndex++}`);
      values.push(updates.draftType);
    }
    if (updates.scheduledStart !== undefined) {
      setClauses.push(`scheduled_start = $${paramIndex++}`);
      values.push(updates.scheduledStart);
    }

    if (setClauses.length === 0) {
      const existing = await this.findById(id);
      if (!existing) throw new Error('Draft not found');
      return existing;
    }

    values.push(id);
    const result = await this.db.query(
      `UPDATE drafts SET ${setClauses.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $${paramIndex}
       RETURNING *`,
      values
    );

    return draftFromDatabase(result.rows[0]);
  }

  async delete(id: number): Promise<void> {
    await this.db.query('DELETE FROM drafts WHERE id = $1', [id]);
  }

  async setOrderConfirmed(draftId: number, confirmed: boolean): Promise<void> {
    await this.db.query(
      'UPDATE drafts SET order_confirmed = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [confirmed, draftId]
    );
  }

  // Draft Order
  async getDraftOrder(
    draftId: number,
    limit?: number,
    offset?: number
  ): Promise<DraftOrderEntry[]> {
    let query = `SELECT dord.*,
       COALESCE(r.settings->>'team_name', u.username, 'Team ' || r.roster_id) as username,
       r.user_id
       FROM draft_order dord
       LEFT JOIN rosters r ON dord.roster_id = r.id
       LEFT JOIN users u ON r.user_id = u.id
       WHERE dord.draft_id = $1
       ORDER BY dord.draft_position`;

    const params: number[] = [draftId];

    if (limit !== undefined) {
      params.push(limit);
      query += ` LIMIT $${params.length}`;
    }

    if (offset !== undefined) {
      params.push(offset);
      query += ` OFFSET $${params.length}`;
    }

    const result = await this.db.query(query, params);
    return result.rows.map((row) => ({
      id: row.id,
      draftId: row.draft_id,
      rosterId: row.roster_id,
      draftPosition: row.draft_position,
      username: row.username,
      userId: row.user_id,
      isAutodraftEnabled: row.is_autodraft_enabled ?? false,
    }));
  }

  async setAutodraftEnabled(draftId: number, rosterId: number, enabled: boolean): Promise<void> {
    await this.db.query(
      `UPDATE draft_order SET is_autodraft_enabled = $1 WHERE draft_id = $2 AND roster_id = $3`,
      [enabled, draftId, rosterId]
    );
  }

  async getAutodraftEnabled(draftId: number, rosterId: number): Promise<boolean> {
    const result = await this.db.query(
      `SELECT is_autodraft_enabled FROM draft_order WHERE draft_id = $1 AND roster_id = $2`,
      [draftId, rosterId]
    );
    return result.rows.length > 0 ? (result.rows[0].is_autodraft_enabled ?? false) : false;
  }

  async createDraftOrder(draftId: number, rosterId: number, position: number): Promise<void> {
    await this.db.query(
      `INSERT INTO draft_order (draft_id, roster_id, draft_position)
       VALUES ($1, $2, $3)
       ON CONFLICT (draft_id, roster_id) DO UPDATE SET draft_position = EXCLUDED.draft_position`,
      [draftId, rosterId, position]
    );
  }

  async clearDraftOrder(draftId: number): Promise<void> {
    await this.db.query('DELETE FROM draft_order WHERE draft_id = $1', [draftId]);
  }

  /**
   * Atomically updates the draft order within a transaction.
   * Clears existing order and inserts new positions in a single transaction.
   * @param draftId - The draft ID
   * @param rosterIds - Array of roster IDs in desired order (index 0 = position 1)
   */
  async updateDraftOrderAtomic(draftId: number, rosterIds: number[]): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // Clear existing order
      await client.query('DELETE FROM draft_order WHERE draft_id = $1', [draftId]);

      // Insert new order using properly parameterized batch insert
      if (rosterIds.length > 0) {
        // Build parameterized placeholders: ($1, $2, $3), ($1, $4, $5), etc.
        const values: number[] = [draftId];
        const placeholders = rosterIds
          .map((rosterId, index) => {
            const rosterParamIndex = values.length + 1;
            const positionParamIndex = values.length + 2;
            values.push(rosterId, index + 1);
            return `($1, $${rosterParamIndex}, $${positionParamIndex})`;
          })
          .join(', ');

        await client.query(
          `INSERT INTO draft_order (draft_id, roster_id, draft_position) VALUES ${placeholders}`,
          values
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Draft Picks
  async getDraftPicks(draftId: number, limit?: number, offset?: number): Promise<DraftPick[]> {
    let query = `SELECT dp.*, p.full_name as player_name, p.position as player_position, p.team as player_team, u.username
       FROM draft_picks dp
       LEFT JOIN players p ON dp.player_id = p.id
       LEFT JOIN rosters r ON dp.roster_id = r.id
       LEFT JOIN users u ON r.user_id = u.id
       WHERE dp.draft_id = $1
       ORDER BY dp.pick_number`;

    const params: number[] = [draftId];

    if (limit !== undefined) {
      params.push(limit);
      query += ` LIMIT $${params.length}`;
    }

    if (offset !== undefined) {
      params.push(offset);
      query += ` OFFSET $${params.length}`;
    }

    const result = await this.db.query(query, params);
    return result.rows.map((row) => ({
      id: row.id,
      draftId: row.draft_id,
      pickNumber: row.pick_number,
      round: row.round,
      pickInRound: row.pick_in_round,
      rosterId: row.roster_id,
      playerId: row.player_id,
      isAutoPick: row.is_auto_pick,
      pickedAt: row.picked_at,
      playerName: row.player_name,
      playerPosition: row.player_position,
      playerTeam: row.player_team,
      username: row.username,
    }));
  }

  async createDraftPick(
    draftId: number,
    pickNumber: number,
    round: number,
    pickInRound: number,
    rosterId: number,
    playerId: number
  ): Promise<DraftPick> {
    const result = await this.db.query(
      `INSERT INTO draft_picks (draft_id, pick_number, round, pick_in_round, roster_id, player_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [draftId, pickNumber, round, pickInRound, rosterId, playerId]
    );
    const row = result.rows[0];
    return {
      id: row.id,
      draftId: row.draft_id,
      pickNumber: row.pick_number,
      round: row.round,
      pickInRound: row.pick_in_round,
      rosterId: row.roster_id,
      playerId: row.player_id,
      isAutoPick: row.is_auto_pick,
      pickedAt: row.picked_at,
    };
  }

  /**
   * Creates a draft pick and removes the player from all queues atomically.
   * Uses pg_advisory_xact_lock to prevent race conditions between concurrent picks.
   * Supports idempotency keys for safe retries.
   */
  async createDraftPickWithCleanup(
    draftId: number,
    pickNumber: number,
    round: number,
    pickInRound: number,
    rosterId: number,
    playerId: number,
    idempotencyKey?: string
  ): Promise<DraftPick> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // Acquire advisory lock on draft to prevent race conditions
      await client.query('SELECT pg_advisory_xact_lock($1)', [getDraftLockId(draftId)]);

      // Check idempotency - return existing pick if found
      if (idempotencyKey) {
        const existing = await client.query(
          `SELECT * FROM draft_picks
           WHERE draft_id = $1 AND roster_id = $2 AND idempotency_key = $3`,
          [draftId, rosterId, idempotencyKey]
        );
        if (existing.rows.length > 0) {
          await client.query('COMMIT');
          const row = existing.rows[0];
          return {
            id: row.id,
            draftId: row.draft_id,
            pickNumber: row.pick_number,
            round: row.round,
            pickInRound: row.pick_in_round,
            rosterId: row.roster_id,
            playerId: row.player_id,
            isAutoPick: row.is_auto_pick,
            pickedAt: row.picked_at,
          };
        }
      }

      // Re-check player not drafted (inside lock to prevent race condition)
      const alreadyDrafted = await client.query(
        'SELECT 1 FROM draft_picks WHERE draft_id = $1 AND player_id = $2',
        [draftId, playerId]
      );
      if (alreadyDrafted.rows.length > 0) {
        await client.query('ROLLBACK');
        throw new ConflictException('Player has already been drafted');
      }

      // Create the pick with idempotency key
      const pickResult = await client.query(
        `INSERT INTO draft_picks (draft_id, pick_number, round, pick_in_round, roster_id, player_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [draftId, pickNumber, round, pickInRound, rosterId, playerId, idempotencyKey || null]
      );

      // Remove player from all queues in this draft
      await client.query('DELETE FROM draft_queue WHERE draft_id = $1 AND player_id = $2', [
        draftId,
        playerId,
      ]);

      await client.query('COMMIT');

      const row = pickResult.rows[0];
      return {
        id: row.id,
        draftId: row.draft_id,
        pickNumber: row.pick_number,
        round: row.round,
        pickInRound: row.pick_in_round,
        rosterId: row.roster_id,
        playerId: row.player_id,
        isAutoPick: row.is_auto_pick,
        pickedAt: row.picked_at,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Undoes the most recent draft pick atomically.
   * Uses advisory lock to prevent race conditions.
   * Returns the deleted pick with player info, or null if no picks exist.
   */
  async undoLastPick(draftId: number): Promise<DraftPick | null> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // Acquire advisory lock on draft
      await client.query('SELECT pg_advisory_xact_lock($1)', [getDraftLockId(draftId)]);

      // Get most recent pick with player info
      const lastPick = await client.query(
        `SELECT dp.*, p.full_name as player_name, p.position as player_position, p.team as player_team, u.username
         FROM draft_picks dp
         LEFT JOIN players p ON dp.player_id = p.id
         LEFT JOIN rosters r ON dp.roster_id = r.id
         LEFT JOIN users u ON r.user_id = u.id
         WHERE dp.draft_id = $1
         ORDER BY dp.pick_number DESC LIMIT 1`,
        [draftId]
      );

      if (lastPick.rows.length === 0) {
        await client.query('COMMIT');
        return null;
      }

      const row = lastPick.rows[0];

      // Delete the pick
      await client.query('DELETE FROM draft_picks WHERE id = $1', [row.id]);

      await client.query('COMMIT');

      return {
        id: row.id,
        draftId: row.draft_id,
        pickNumber: row.pick_number,
        round: row.round,
        pickInRound: row.pick_in_round,
        rosterId: row.roster_id,
        playerId: row.player_id,
        isAutoPick: row.is_auto_pick,
        pickedAt: row.picked_at,
        playerName: row.player_name,
        playerPosition: row.player_position,
        playerTeam: row.player_team,
        username: row.username,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async isPlayerDrafted(draftId: number, playerId: number): Promise<boolean> {
    const result = await this.db.query(
      'SELECT EXISTS(SELECT 1 FROM draft_picks WHERE draft_id = $1 AND player_id = $2)',
      [draftId, playerId]
    );
    return result.rows[0].exists;
  }

  async getDraftedPlayerIds(draftId: number): Promise<Set<number>> {
    const result = await this.db.query(
      'SELECT player_id FROM draft_picks WHERE draft_id = $1 AND player_id IS NOT NULL',
      [draftId]
    );
    return new Set(result.rows.map((row) => row.player_id));
  }

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

  async markPickAsAutoPick(pickId: number): Promise<void> {
    await this.db.query('UPDATE draft_picks SET is_auto_pick = true WHERE id = $1', [pickId]);
  }

  /**
   * Atomically make a pick and advance the draft state in a single transaction.
   * This prevents race conditions where pick is inserted but draft state doesn't advance.
   *
   * @param params.draftId - The draft ID
   * @param params.expectedPickNumber - The pick number we expect to be making (validates no race condition)
   * @param params.round - The round number
   * @param params.pickInRound - The pick position within the round
   * @param params.rosterId - The roster making the pick
   * @param params.playerId - The player being picked
   * @param params.nextPickState - Pre-computed next pick state (currentPick, currentRound, currentRosterId, pickDeadline, status)
   * @param params.idempotencyKey - Optional idempotency key for safe retries
   * @returns The created pick and updated draft
   */
  async makePickAndAdvanceTx(params: {
    draftId: number;
    expectedPickNumber: number;
    round: number;
    pickInRound: number;
    rosterId: number;
    playerId: number;
    nextPickState: {
      currentPick: number | null;
      currentRound: number | null;
      currentRosterId: number | null;
      pickDeadline: Date | null;
      status?: 'in_progress' | 'completed';
      completedAt?: Date | null;
    };
    idempotencyKey?: string;
  }): Promise<{ pick: DraftPick; draft: Draft }> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // 1. Acquire advisory lock on draft to prevent concurrent picks
      await client.query('SELECT pg_advisory_xact_lock($1)', [getDraftLockId(params.draftId)]);

      // 2. Re-read draft row FOR UPDATE and validate current state
      const draftResult = await client.query('SELECT * FROM drafts WHERE id = $1 FOR UPDATE', [
        params.draftId,
      ]);
      if (draftResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new ConflictException('Draft not found');
      }
      const currentDraft = draftFromDatabase(draftResult.rows[0]);

      // 3. Validate draft is in correct state
      if (currentDraft.status !== 'in_progress') {
        await client.query('ROLLBACK');
        throw new ConflictException('Draft is not in progress');
      }

      // 4. Check idempotency FIRST - return existing pick if found
      // This MUST happen before pick number validation to handle retries correctly.
      // If a client's HTTP response times out after a successful pick, the draft
      // will have advanced. On retry, we must return the cached pick immediately
      // rather than failing validation due to the advanced pick number.
      if (params.idempotencyKey) {
        const existing = await client.query(
          `SELECT * FROM draft_picks
           WHERE draft_id = $1 AND roster_id = $2 AND idempotency_key = $3`,
          [params.draftId, params.rosterId, params.idempotencyKey]
        );
        if (existing.rows.length > 0) {
          await client.query('COMMIT');
          const row = existing.rows[0];
          return {
            pick: {
              id: row.id,
              draftId: row.draft_id,
              pickNumber: row.pick_number,
              round: row.round,
              pickInRound: row.pick_in_round,
              rosterId: row.roster_id,
              playerId: row.player_id,
              isAutoPick: row.is_auto_pick,
              pickedAt: row.picked_at,
            },
            draft: currentDraft,
          };
        }
      }

      // 5. Critical: Validate expected pick number matches current state
      if (currentDraft.currentPick !== params.expectedPickNumber) {
        await client.query('ROLLBACK');
        throw new ConflictException(
          `Pick already made. Expected pick ${params.expectedPickNumber}, but draft is at pick ${currentDraft.currentPick}`
        );
      }

      // 6. Validate it's the correct roster's turn
      if (currentDraft.currentRosterId !== params.rosterId) {
        await client.query('ROLLBACK');
        throw new ConflictException('It is not your turn to pick');
      }

      // 7. Validate player not already drafted
      const alreadyDrafted = await client.query(
        'SELECT 1 FROM draft_picks WHERE draft_id = $1 AND player_id = $2',
        [params.draftId, params.playerId]
      );
      if (alreadyDrafted.rows.length > 0) {
        await client.query('ROLLBACK');
        throw new ConflictException('Player has already been drafted');
      }

      // 8. Insert the pick
      const pickResult = await client.query(
        `INSERT INTO draft_picks (draft_id, pick_number, round, pick_in_round, roster_id, player_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          params.draftId,
          params.expectedPickNumber,
          params.round,
          params.pickInRound,
          params.rosterId,
          params.playerId,
          params.idempotencyKey || null,
        ]
      );

      // 9. Remove player from all queues in this draft
      await client.query('DELETE FROM draft_queue WHERE draft_id = $1 AND player_id = $2', [
        params.draftId,
        params.playerId,
      ]);

      // 10. Update draft state atomically
      const updateClauses: string[] = [];
      const updateValues: any[] = [];
      let paramIndex = 1;

      if (params.nextPickState.status) {
        updateClauses.push(`status = $${paramIndex++}`);
        updateValues.push(params.nextPickState.status);
      }
      if (params.nextPickState.currentPick !== undefined) {
        updateClauses.push(`current_pick = $${paramIndex++}`);
        updateValues.push(params.nextPickState.currentPick);
      }
      if (params.nextPickState.currentRound !== undefined) {
        updateClauses.push(`current_round = $${paramIndex++}`);
        updateValues.push(params.nextPickState.currentRound);
      }
      if (params.nextPickState.currentRosterId !== undefined) {
        updateClauses.push(`current_roster_id = $${paramIndex++}`);
        updateValues.push(params.nextPickState.currentRosterId);
      }
      if (params.nextPickState.pickDeadline !== undefined) {
        updateClauses.push(`pick_deadline = $${paramIndex++}`);
        updateValues.push(params.nextPickState.pickDeadline);
      }
      if (params.nextPickState.completedAt !== undefined) {
        updateClauses.push(`completed_at = $${paramIndex++}`);
        updateValues.push(params.nextPickState.completedAt);
      }

      updateValues.push(params.draftId);
      const updatedDraftResult = await client.query(
        `UPDATE drafts SET ${updateClauses.join(', ')}, updated_at = CURRENT_TIMESTAMP
         WHERE id = $${paramIndex}
         RETURNING *`,
        updateValues
      );

      await client.query('COMMIT');

      const row = pickResult.rows[0];
      return {
        pick: {
          id: row.id,
          draftId: row.draft_id,
          pickNumber: row.pick_number,
          round: row.round,
          pickInRound: row.pick_in_round,
          rosterId: row.roster_id,
          playerId: row.player_id,
          isAutoPick: row.is_auto_pick,
          pickedAt: row.picked_at,
        },
        draft: draftFromDatabase(updatedDraftResult.rows[0]),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Check if a pick already exists for the given draft and pick number.
   * Used to detect race conditions where a pick was made but draft state wasn't updated.
   */
  async pickExists(draftId: number, pickNumber: number): Promise<boolean> {
    const result = await this.db.query(
      'SELECT 1 FROM draft_picks WHERE draft_id = $1 AND pick_number = $2',
      [draftId, pickNumber]
    );
    return result.rows.length > 0;
  }

  async getBestAvailablePlayer(
    draftId: number,
    playerPool: string[] = ['veteran', 'rookie']
  ): Promise<number | null> {
    // Build WHERE clause based on playerPool
    // veteran: player_type = 'nfl' AND (years_exp > 0 OR years_exp IS NULL)
    // rookie: player_type = 'nfl' AND years_exp = 0
    // college: player_type = 'college'
    const conditions: string[] = [];
    if (playerPool.includes('veteran')) {
      conditions.push("(player_type = 'nfl' AND (years_exp > 0 OR years_exp IS NULL))");
    }
    if (playerPool.includes('rookie')) {
      conditions.push("(player_type = 'nfl' AND years_exp = 0)");
    }
    if (playerPool.includes('college')) {
      conditions.push("(player_type = 'college')");
    }

    const playerFilter = conditions.length > 0
      ? `AND (${conditions.join(' OR ')})`
      : '';

    const result = await this.db.query(
      `SELECT id FROM players
       WHERE active = true
       ${playerFilter}
       AND id NOT IN (SELECT player_id FROM draft_picks WHERE draft_id = $1 AND player_id IS NOT NULL)
       ORDER BY
         CASE position
           WHEN 'QB' THEN 1
           WHEN 'RB' THEN 2
           WHEN 'WR' THEN 3
           WHEN 'TE' THEN 4
           WHEN 'K' THEN 5
           WHEN 'DEF' THEN 6
           ELSE 7
         END,
         id
       LIMIT 1`,
      [draftId]
    );
    return result.rows.length > 0 ? result.rows[0].id : null;
  }

  // Draft Queue
  async getQueue(draftId: number, rosterId: number): Promise<QueueEntry[]> {
    const result = await this.db.query(
      `SELECT dq.*, p.full_name as player_name, p.position as player_position, p.team as player_team
       FROM draft_queue dq
       LEFT JOIN players p ON dq.player_id = p.id
       WHERE dq.draft_id = $1 AND dq.roster_id = $2
       ORDER BY dq.queue_position`,
      [draftId, rosterId]
    );
    return result.rows.map((row) => ({
      id: row.id,
      draftId: row.draft_id,
      rosterId: row.roster_id,
      playerId: row.player_id,
      queuePosition: row.queue_position,
      playerName: row.player_name,
      playerPosition: row.player_position,
      playerTeam: row.player_team,
    }));
  }

  async addToQueue(draftId: number, rosterId: number, playerId: number): Promise<QueueEntry> {
    // Single query: calculate position and insert atomically
    const result = await this.db.query(
      `INSERT INTO draft_queue (draft_id, roster_id, player_id, queue_position)
       SELECT $1, $2, $3, COALESCE(MAX(queue_position), 0) + 1
       FROM draft_queue WHERE draft_id = $1 AND roster_id = $2
       ON CONFLICT (draft_id, roster_id, player_id) DO NOTHING
       RETURNING *`,
      [draftId, rosterId, playerId]
    );

    if (result.rows.length === 0) {
      throw new Error('Player already in queue');
    }

    const row = result.rows[0];
    return {
      id: row.id,
      draftId: row.draft_id,
      rosterId: row.roster_id,
      playerId: row.player_id,
      queuePosition: row.queue_position,
    };
  }

  async removeFromQueue(queueId: number): Promise<void> {
    await this.db.query('DELETE FROM draft_queue WHERE id = $1', [queueId]);
  }

  async removeFromQueueByPlayer(
    draftId: number,
    rosterId: number,
    playerId: number
  ): Promise<void> {
    await this.db.query(
      'DELETE FROM draft_queue WHERE draft_id = $1 AND roster_id = $2 AND player_id = $3',
      [draftId, rosterId, playerId]
    );
  }

  async removePlayerFromAllQueues(draftId: number, playerId: number): Promise<void> {
    await this.db.query('DELETE FROM draft_queue WHERE draft_id = $1 AND player_id = $2', [
      draftId,
      playerId,
    ]);
  }

  async reorderQueue(draftId: number, rosterId: number, playerIds: number[]): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      // Delete existing queue entries for this user
      await client.query('DELETE FROM draft_queue WHERE draft_id = $1 AND roster_id = $2', [
        draftId,
        rosterId,
      ]);
      // Insert in new order
      for (let i = 0; i < playerIds.length; i++) {
        await client.query(
          'INSERT INTO draft_queue (draft_id, roster_id, player_id, queue_position) VALUES ($1, $2, $3, $4)',
          [draftId, rosterId, playerIds[i], i + 1]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export interface QueueEntry {
  id: number;
  draftId: number;
  rosterId: number;
  playerId: number;
  queuePosition: number;
  playerName?: string;
  playerPosition?: string;
  playerTeam?: string;
}
