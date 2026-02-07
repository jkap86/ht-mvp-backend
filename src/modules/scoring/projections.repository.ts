import { Pool, PoolClient } from 'pg';
import { PlayerStats, playerProjectionFromDatabase } from './scoring.model';

/**
 * Repository for player projections.
 * Uses the same PlayerStats interface since projections have identical structure,
 * but stores data in the separate player_projections table to avoid overwriting actual stats.
 */
export class PlayerProjectionsRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Get projection for a player in a specific week
   */
  async findByPlayerAndWeek(
    playerId: number,
    season: number,
    week: number
  ): Promise<PlayerStats | null> {
    const result = await this.db.query(
      `SELECT * FROM player_projections
       WHERE player_id = $1 AND season = $2 AND week = $3`,
      [playerId, season, week]
    );

    if (result.rows.length === 0) return null;
    return playerProjectionFromDatabase(result.rows[0]);
  }

  /**
   * Get projections for multiple players in a specific week
   */
  async findByPlayersAndWeek(
    playerIds: number[],
    season: number,
    week: number
  ): Promise<PlayerStats[]> {
    if (playerIds.length === 0) return [];

    const result = await this.db.query(
      `SELECT * FROM player_projections
       WHERE player_id = ANY($1) AND season = $2 AND week = $3`,
      [playerIds, season, week]
    );

    return result.rows.map(playerProjectionFromDatabase);
  }

  /**
   * Upsert player projection (insert or update)
   */
  async upsert(
    projection: Partial<PlayerStats> & { playerId: number; season: number; week: number },
    client?: PoolClient
  ): Promise<PlayerStats> {
    const db = client || this.db;
    const result = await db.query(
      `INSERT INTO player_projections (
        player_id, season, week,
        pass_yards, pass_td, pass_int,
        rush_yards, rush_td,
        receptions, rec_yards, rec_td,
        fumbles_lost, two_pt_conversions,
        fg_made, fg_missed, pat_made, pat_missed,
        def_td, def_int, def_sacks, def_fumble_rec, def_safety, def_points_allowed
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
      ON CONFLICT (player_id, season, week)
      DO UPDATE SET
        pass_yards = EXCLUDED.pass_yards,
        pass_td = EXCLUDED.pass_td,
        pass_int = EXCLUDED.pass_int,
        rush_yards = EXCLUDED.rush_yards,
        rush_td = EXCLUDED.rush_td,
        receptions = EXCLUDED.receptions,
        rec_yards = EXCLUDED.rec_yards,
        rec_td = EXCLUDED.rec_td,
        fumbles_lost = EXCLUDED.fumbles_lost,
        two_pt_conversions = EXCLUDED.two_pt_conversions,
        fg_made = EXCLUDED.fg_made,
        fg_missed = EXCLUDED.fg_missed,
        pat_made = EXCLUDED.pat_made,
        pat_missed = EXCLUDED.pat_missed,
        def_td = EXCLUDED.def_td,
        def_int = EXCLUDED.def_int,
        def_sacks = EXCLUDED.def_sacks,
        def_fumble_rec = EXCLUDED.def_fumble_rec,
        def_safety = EXCLUDED.def_safety,
        def_points_allowed = EXCLUDED.def_points_allowed,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *`,
      [
        projection.playerId,
        projection.season,
        projection.week,
        projection.passYards || 0,
        projection.passTd || 0,
        projection.passInt || 0,
        projection.rushYards || 0,
        projection.rushTd || 0,
        projection.receptions || 0,
        projection.recYards || 0,
        projection.recTd || 0,
        projection.fumblesLost || 0,
        projection.twoPtConversions || 0,
        projection.fgMade || 0,
        projection.fgMissed || 0,
        projection.patMade || 0,
        projection.patMissed || 0,
        projection.defTd || 0,
        projection.defInt || 0,
        projection.defSacks || 0,
        projection.defFumbleRec || 0,
        projection.defSafety || 0,
        projection.defPointsAllowed || 0,
      ]
    );

    return playerProjectionFromDatabase(result.rows[0]);
  }

  /**
   * Bulk upsert player projections
   */
  async bulkUpsert(
    projectionsList: Array<Partial<PlayerStats> & { playerId: number; season: number; week: number }>
  ): Promise<void> {
    if (projectionsList.length === 0) return;

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      for (const projection of projectionsList) {
        await this.upsert(projection, client);
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
