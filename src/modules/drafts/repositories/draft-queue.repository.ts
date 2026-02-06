/**
 * Draft Queue Repository
 *
 * Handles draft queue operations for managing player/pick asset queues.
 */

import type { Pool, PoolClient } from 'pg';
import { runInTransaction } from '../../../shared/transaction-runner';

export interface QueueEntry {
  id: number;
  draftId: number;
  rosterId: number;
  playerId: number | null;
  queuePosition: number;
  playerName?: string;
  playerPosition?: string;
  playerTeam?: string;
  pickAssetId: number | null;
  pickAssetSeason?: number;
  pickAssetRound?: number;
  pickAssetDisplayName?: string;
  originalTeamName?: string;
}

export class DraftQueueRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Get queue entries for a roster in a draft.
   */
  async getQueue(draftId: number, rosterId: number): Promise<QueueEntry[]> {
    const result = await this.db.query(
      `SELECT dq.*,
              p.full_name as player_name, p.position as player_position, p.team as player_team,
              dpa.season as pick_asset_season, dpa.round as pick_asset_round,
              COALESCE(orig_r.settings->>'team_name', orig_u.username, 'Team ' || orig_r.id) as original_team_name
       FROM draft_queue dq
       LEFT JOIN players p ON dq.player_id = p.id
       LEFT JOIN draft_pick_assets dpa ON dq.pick_asset_id = dpa.id
       LEFT JOIN rosters orig_r ON dpa.original_roster_id = orig_r.id
       LEFT JOIN users orig_u ON orig_r.user_id = orig_u.id
       WHERE dq.draft_id = $1 AND dq.roster_id = $2
       ORDER BY dq.queue_position`,
      [draftId, rosterId]
    );
    return this.mapQueueRows(result.rows);
  }

  /**
   * Add a player or pick asset to the queue.
   * One of playerId or pickAssetId must be provided, but not both.
   */
  async addToQueue(
    draftId: number,
    rosterId: number,
    playerId?: number,
    pickAssetId?: number
  ): Promise<QueueEntry> {
    if (!playerId && !pickAssetId) {
      throw new Error('Either playerId or pickAssetId must be provided');
    }
    if (playerId && pickAssetId) {
      throw new Error('Cannot provide both playerId and pickAssetId');
    }

    // Single query: calculate position and insert atomically
    const result = await this.db.query(
      `INSERT INTO draft_queue (draft_id, roster_id, player_id, pick_asset_id, queue_position)
       SELECT $1, $2, $3, $4, COALESCE(MAX(queue_position), 0) + 1
       FROM draft_queue WHERE draft_id = $1 AND roster_id = $2
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [draftId, rosterId, playerId || null, pickAssetId || null]
    );

    if (result.rows.length === 0) {
      throw new Error(playerId ? 'Player already in queue' : 'Pick asset already in queue');
    }

    const row = result.rows[0];
    return {
      id: row.id,
      draftId: row.draft_id,
      rosterId: row.roster_id,
      playerId: row.player_id,
      queuePosition: row.queue_position,
      pickAssetId: row.pick_asset_id,
    };
  }

  /**
   * Remove a queue entry by ID.
   */
  async removeFromQueue(queueId: number): Promise<void> {
    await this.db.query('DELETE FROM draft_queue WHERE id = $1', [queueId]);
  }

  /**
   * Remove a player from a roster's queue.
   */
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

  /**
   * Remove a player from all queues in a draft.
   */
  async removePlayerFromAllQueues(draftId: number, playerId: number): Promise<void> {
    await this.db.query('DELETE FROM draft_queue WHERE draft_id = $1 AND player_id = $2', [
      draftId,
      playerId,
    ]);
  }

  /**
   * Remove a player from all queues using an existing client (for transactions).
   */
  async removePlayerFromAllQueuesWithClient(
    client: PoolClient,
    draftId: number,
    playerId: number
  ): Promise<void> {
    await client.query('DELETE FROM draft_queue WHERE draft_id = $1 AND player_id = $2', [
      draftId,
      playerId,
    ]);
  }

  /**
   * Remove a pick asset from a roster's queue.
   */
  async removeFromQueueByPickAsset(
    draftId: number,
    rosterId: number,
    pickAssetId: number
  ): Promise<void> {
    await this.db.query(
      'DELETE FROM draft_queue WHERE draft_id = $1 AND roster_id = $2 AND pick_asset_id = $3',
      [draftId, rosterId, pickAssetId]
    );
  }

  /**
   * Remove a pick asset from all queues in a draft.
   */
  async removePickAssetFromAllQueues(draftId: number, pickAssetId: number): Promise<void> {
    await this.db.query('DELETE FROM draft_queue WHERE draft_id = $1 AND pick_asset_id = $2', [
      draftId,
      pickAssetId,
    ]);
  }

  /**
   * Remove a pick asset from all queues using an existing client (for transactions).
   */
  async removePickAssetFromAllQueuesWithClient(
    client: PoolClient,
    draftId: number,
    pickAssetId: number
  ): Promise<void> {
    await client.query('DELETE FROM draft_queue WHERE draft_id = $1 AND pick_asset_id = $2', [
      draftId,
      pickAssetId,
    ]);
  }

  /**
   * Reorder queue using entry IDs (supports mixed player + pick asset queues).
   * Falls back to legacy player-only behavior if entryIds not provided.
   */
  async reorderQueue(
    draftId: number,
    rosterId: number,
    playerIds: number[],
    entryIds?: number[]
  ): Promise<void> {
    await runInTransaction(this.db, async (client) => {
      if (entryIds && entryIds.length > 0) {
        // New behavior: reorder by entry IDs (supports mixed queue)
        for (let i = 0; i < entryIds.length; i++) {
          await client.query(
            'UPDATE draft_queue SET queue_position = $1 WHERE id = $2 AND draft_id = $3 AND roster_id = $4',
            [i + 1, entryIds[i], draftId, rosterId]
          );
        }
      } else {
        // Legacy behavior: reorder by player IDs only
        await client.query('DELETE FROM draft_queue WHERE draft_id = $1 AND roster_id = $2', [
          draftId,
          rosterId,
        ]);
        for (let i = 0; i < playerIds.length; i++) {
          await client.query(
            'INSERT INTO draft_queue (draft_id, roster_id, player_id, queue_position) VALUES ($1, $2, $3, $4)',
            [draftId, rosterId, playerIds[i], i + 1]
          );
        }
      }
    });
  }

  /**
   * Map database rows to QueueEntry objects.
   */
  private mapQueueRows(rows: any[]): QueueEntry[] {
    return rows.map((row) => {
      let pickAssetDisplayName: string | undefined;
      if (row.pick_asset_id) {
        pickAssetDisplayName = `${row.pick_asset_season} Round ${row.pick_asset_round} - ${row.original_team_name}`;
      }
      return {
        id: row.id,
        draftId: row.draft_id,
        rosterId: row.roster_id,
        playerId: row.player_id,
        queuePosition: row.queue_position,
        playerName: row.player_name,
        playerPosition: row.player_position,
        playerTeam: row.player_team,
        pickAssetId: row.pick_asset_id,
        pickAssetSeason: row.pick_asset_season,
        pickAssetRound: row.pick_asset_round,
        pickAssetDisplayName,
        originalTeamName: row.original_team_name,
      };
    });
  }
}
