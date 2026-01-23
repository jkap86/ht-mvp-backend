import { Pool } from 'pg';
import { Draft, DraftOrderEntry, DraftPick, draftFromDatabase } from './drafts.model';
import { ConflictException } from '../../utils/exceptions';

export class DraftRepository {
  constructor(private readonly db: Pool) {}

  async findById(id: number): Promise<Draft | null> {
    const result = await this.db.query('SELECT * FROM drafts WHERE id = $1', [id]);
    return result.rows.length > 0 ? draftFromDatabase(result.rows[0]) : null;
  }

  async findByLeagueId(leagueId: number): Promise<Draft[]> {
    const result = await this.db.query(
      'SELECT * FROM drafts WHERE league_id = $1 ORDER BY created_at DESC',
      [leagueId]
    );
    return result.rows.map(draftFromDatabase);
  }

  async create(leagueId: number, draftType: string, rounds: number, pickTimeSeconds: number): Promise<Draft> {
    const result = await this.db.query(
      `INSERT INTO drafts (league_id, draft_type, rounds, pick_time_seconds)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [leagueId, draftType, rounds, pickTimeSeconds]
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

  // Draft Order
  async getDraftOrder(draftId: number): Promise<DraftOrderEntry[]> {
    const result = await this.db.query(
      `SELECT dord.*, u.username
       FROM draft_order dord
       LEFT JOIN rosters r ON dord.roster_id = r.id
       LEFT JOIN users u ON r.user_id = u.id
       WHERE dord.draft_id = $1
       ORDER BY dord.draft_position`,
      [draftId]
    );
    return result.rows.map(row => ({
      id: row.id,
      draftId: row.draft_id,
      rosterId: row.roster_id,
      draftPosition: row.draft_position,
      username: row.username,
    }));
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

  // Draft Picks
  async getDraftPicks(draftId: number): Promise<DraftPick[]> {
    const result = await this.db.query(
      `SELECT dp.*, p.full_name as player_name, p.position as player_position, p.team as player_team, u.username
       FROM draft_picks dp
       LEFT JOIN players p ON dp.player_id = p.id
       LEFT JOIN rosters r ON dp.roster_id = r.id
       LEFT JOIN users u ON r.user_id = u.id
       WHERE dp.draft_id = $1
       ORDER BY dp.pick_number`,
      [draftId]
    );
    return result.rows.map(row => ({
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
      await client.query('SELECT pg_advisory_xact_lock($1)', [draftId]);

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
      await client.query(
        'DELETE FROM draft_queue WHERE draft_id = $1 AND player_id = $2',
        [draftId, playerId]
      );

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
      await client.query('SELECT pg_advisory_xact_lock($1)', [draftId]);

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
    return new Set(result.rows.map(row => row.player_id));
  }

  async findExpiredDrafts(): Promise<Draft[]> {
    const result = await this.db.query(
      `SELECT * FROM drafts
       WHERE status = 'in_progress'
       AND pick_deadline IS NOT NULL
       AND pick_deadline < NOW()`
    );
    return result.rows.map(draftFromDatabase);
  }

  async markPickAsAutoPick(pickId: number): Promise<void> {
    await this.db.query(
      'UPDATE draft_picks SET is_auto_pick = true WHERE id = $1',
      [pickId]
    );
  }

  async getBestAvailablePlayer(draftId: number): Promise<number | null> {
    const result = await this.db.query(
      `SELECT id FROM players
       WHERE active = true
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
    return result.rows.map(row => ({
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

  async removeFromQueueByPlayer(draftId: number, rosterId: number, playerId: number): Promise<void> {
    await this.db.query(
      'DELETE FROM draft_queue WHERE draft_id = $1 AND roster_id = $2 AND player_id = $3',
      [draftId, rosterId, playerId]
    );
  }

  async removePlayerFromAllQueues(draftId: number, playerId: number): Promise<void> {
    await this.db.query(
      'DELETE FROM draft_queue WHERE draft_id = $1 AND player_id = $2',
      [draftId, playerId]
    );
  }

  async reorderQueue(draftId: number, rosterId: number, playerIds: number[]): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      // Delete existing queue entries for this user
      await client.query(
        'DELETE FROM draft_queue WHERE draft_id = $1 AND roster_id = $2',
        [draftId, rosterId]
      );
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
