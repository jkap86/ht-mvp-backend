/**
 * KeeperSelectionRepository
 * Repository for managing keeper selections
 */

import { Pool, PoolClient } from 'pg';
import {
  KeeperSelection,
  CreateKeeperSelectionParams,
  KeeperSelectionWithDetails
} from './keeper-selection.model';

// Re-export types for external use
export type { CreateKeeperSelectionParams };

export class KeeperSelectionRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Find a keeper selection by ID
   */
  async findById(id: number, client?: PoolClient): Promise<KeeperSelection | null> {
    const executor = client || this.pool;
    const result = await executor.query(
      'SELECT * FROM keeper_selections WHERE id = $1',
      [id]
    );
    return result.rows[0] ? KeeperSelection.fromDatabase(result.rows[0]) : null;
  }

  /**
   * Find all keeper selections for a league season
   */
  async findByLeagueSeason(
    leagueSeasonId: number,
    client?: PoolClient
  ): Promise<KeeperSelection[]> {
    const executor = client || this.pool;
    const result = await executor.query(
      'SELECT * FROM keeper_selections WHERE league_season_id = $1 ORDER BY roster_id, selected_at',
      [leagueSeasonId]
    );
    return result.rows.map(KeeperSelection.fromDatabase);
  }

  /**
   * Find all keeper selections for a specific roster in a league season
   */
  async findByRoster(
    rosterId: number,
    leagueSeasonId: number,
    client?: PoolClient
  ): Promise<KeeperSelection[]> {
    const executor = client || this.pool;
    const result = await executor.query(
      `SELECT * FROM keeper_selections
       WHERE roster_id = $1 AND league_season_id = $2
       ORDER BY selected_at`,
      [rosterId, leagueSeasonId]
    );
    return result.rows.map(KeeperSelection.fromDatabase);
  }

  /**
   * Find keeper selections with player/pick asset details
   */
  async findByLeagueSeasonWithDetails(
    leagueSeasonId: number,
    client?: PoolClient
  ): Promise<KeeperSelectionWithDetails[]> {
    const executor = client || this.pool;
    const result = await executor.query(
      `SELECT
        ks.*,
        p.full_name as player_name,
        p.position as player_position,
        p.team as player_team,
        dpa.asset_key as pick_asset_label
       FROM keeper_selections ks
       LEFT JOIN players p ON ks.player_id = p.id
       LEFT JOIN draft_pick_assets dpa ON ks.draft_pick_asset_id = dpa.id
       WHERE ks.league_season_id = $1
       ORDER BY ks.roster_id, ks.selected_at`,
      [leagueSeasonId]
    );

    return result.rows.map(row => {
      const keeper = KeeperSelection.fromDatabase(row);
      return Object.assign(keeper, {
        playerName: row.player_name,
        playerPosition: row.player_position,
        playerTeam: row.player_team,
        pickAssetLabel: row.pick_asset_label
      });
    });
  }

  /**
   * Create a new keeper selection
   */
  async create(
    params: CreateKeeperSelectionParams,
    client?: PoolClient
  ): Promise<KeeperSelection> {
    const executor = client || this.pool;

    // Validate XOR: must have either playerId or draftPickAssetId
    if ((params.playerId === undefined && params.draftPickAssetId === undefined) ||
        (params.playerId !== undefined && params.draftPickAssetId !== undefined)) {
      throw new Error('Must provide either playerId or draftPickAssetId, not both or neither');
    }

    const result = await executor.query(
      `INSERT INTO keeper_selections (
        league_season_id, roster_id, player_id, draft_pick_asset_id, keeper_round_cost
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *`,
      [
        params.leagueSeasonId,
        params.rosterId,
        params.playerId || null,
        params.draftPickAssetId || null,
        params.keeperRoundCost || null
      ]
    );
    return KeeperSelection.fromDatabase(result.rows[0]);
  }

  /**
   * Create multiple keeper selections at once (bulk insert)
   */
  async bulkCreate(
    selections: CreateKeeperSelectionParams[],
    client?: PoolClient
  ): Promise<KeeperSelection[]> {
    const executor = client || this.pool;

    if (selections.length === 0) {
      return [];
    }

    // Build bulk insert query
    const values: any[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const selection of selections) {
      // Validate each selection
      if ((selection.playerId === undefined && selection.draftPickAssetId === undefined) ||
          (selection.playerId !== undefined && selection.draftPickAssetId !== undefined)) {
        throw new Error('Each keeper selection must have either playerId or draftPickAssetId');
      }

      placeholders.push(
        `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
      );
      values.push(
        selection.leagueSeasonId,
        selection.rosterId,
        selection.playerId || null,
        selection.draftPickAssetId || null,
        selection.keeperRoundCost || null
      );
    }

    const query = `
      INSERT INTO keeper_selections (
        league_season_id, roster_id, player_id, draft_pick_asset_id, keeper_round_cost
      )
      VALUES ${placeholders.join(', ')}
      RETURNING *
    `;

    const result = await executor.query(query, values);
    return result.rows.map(KeeperSelection.fromDatabase);
  }

  /**
   * Delete all keeper selections for a roster in a league season
   */
  async deleteByRoster(
    rosterId: number,
    leagueSeasonId: number,
    client?: PoolClient
  ): Promise<void> {
    const executor = client || this.pool;
    await executor.query(
      'DELETE FROM keeper_selections WHERE roster_id = $1 AND league_season_id = $2',
      [rosterId, leagueSeasonId]
    );
  }

  /**
   * Delete a specific keeper selection
   */
  async delete(id: number, client?: PoolClient): Promise<void> {
    const executor = client || this.pool;
    await executor.query('DELETE FROM keeper_selections WHERE id = $1', [id]);
  }

  /**
   * Count keeper selections for a roster
   */
  async countByRoster(
    rosterId: number,
    leagueSeasonId: number,
    client?: PoolClient
  ): Promise<number> {
    const executor = client || this.pool;
    const result = await executor.query(
      'SELECT COUNT(*) as count FROM keeper_selections WHERE roster_id = $1 AND league_season_id = $2',
      [rosterId, leagueSeasonId]
    );
    return Number(result.rows[0].count) || 0;
  }

  /**
   * Check if a player is already kept by any roster in the league season
   */
  async isPlayerKept(
    playerId: number,
    leagueSeasonId: number,
    client?: PoolClient
  ): Promise<boolean> {
    const executor = client || this.pool;
    const result = await executor.query(
      'SELECT COUNT(*) as count FROM keeper_selections WHERE player_id = $1 AND league_season_id = $2',
      [playerId, leagueSeasonId]
    );
    return (Number(result.rows[0].count) || 0) > 0;
  }

  /**
   * Get all kept player IDs for a league season
   */
  async getKeptPlayerIds(leagueSeasonId: number, client?: PoolClient): Promise<number[]> {
    const executor = client || this.pool;
    const result = await executor.query(
      'SELECT player_id FROM keeper_selections WHERE league_season_id = $1 AND player_id IS NOT NULL',
      [leagueSeasonId]
    );
    return result.rows.map(row => row.player_id);
  }

  /**
   * Get all kept pick asset IDs for a league season
   */
  async getKeptPickAssetIds(leagueSeasonId: number, client?: PoolClient): Promise<number[]> {
    const executor = client || this.pool;
    const result = await executor.query(
      `SELECT draft_pick_asset_id FROM keeper_selections
       WHERE league_season_id = $1 AND draft_pick_asset_id IS NOT NULL`,
      [leagueSeasonId]
    );
    return result.rows.map(row => row.draft_pick_asset_id);
  }
}
