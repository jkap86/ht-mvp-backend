import { Pool } from 'pg';
import { Draft, DraftOrderEntry, DraftPick, draftFromDatabase } from './drafts.model';

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
      `SELECT do.*, u.username
       FROM draft_order do
       LEFT JOIN rosters r ON do.roster_id = r.id
       LEFT JOIN users u ON r.user_id = u.id
       WHERE do.draft_id = $1
       ORDER BY do.draft_position`,
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

  async isPlayerDrafted(draftId: number, playerId: number): Promise<boolean> {
    const result = await this.db.query(
      'SELECT EXISTS(SELECT 1 FROM draft_picks WHERE draft_id = $1 AND player_id = $2)',
      [draftId, playerId]
    );
    return result.rows[0].exists;
  }
}
