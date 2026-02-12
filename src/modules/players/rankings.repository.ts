/**
 * Player Rankings Repository
 * Phase 2 - Stream F: Player Rankings & Comparison
 *
 * Data access layer for player rankings
 * ALL queries use player_id (internal database primary key) - NO sleeper_id dependencies
 */

import { Pool, PoolClient } from 'pg';
import {
  PlayerRanking,
  CreateRankingData,
  RankingSource,
  RankingPosition,
  playerRankingFromDatabase,
} from './rankings.model';
import { logger } from '../../config/logger.config';

export class RankingsRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Get rankings by position and source
   * Returns players ranked at a specific position from a specific source
   */
  async getRankingsByPosition(
    position: RankingPosition | null,
    source: RankingSource = 'consensus',
    season: number,
    week: number | null = null,
    limit = 200
  ): Promise<PlayerRanking[]> {
    const positionFilter = position === 'OVERALL' ? null : position;

    const result = await this.db.query(
      `SELECT
        pr.*,
        p.full_name as player_name,
        p.position as player_position,
        p.team
       FROM player_rankings pr
       JOIN players p ON p.id = pr.player_id
       WHERE pr.ranking_source = $1
         AND pr.season = $2
         AND ($3::INTEGER IS NULL OR pr.week = $3)
         AND ($4::VARCHAR IS NULL OR pr.position = $4)
       ORDER BY pr.rank ASC
       LIMIT $5`,
      [source, season, week, positionFilter, limit]
    );

    return result.rows.map(playerRankingFromDatabase);
  }

  /**
   * Get all rankings for a specific player across all sources
   */
  async getPlayerRankings(
    playerId: number,
    season: number,
    week: number | null = null
  ): Promise<PlayerRanking[]> {
    const result = await this.db.query(
      `SELECT
        pr.*,
        p.full_name as player_name,
        p.position as player_position,
        p.team
       FROM player_rankings pr
       JOIN players p ON p.id = pr.player_id
       WHERE pr.player_id = $1
         AND pr.season = $2
         AND ($3::INTEGER IS NULL OR pr.week = $3)
       ORDER BY pr.ranking_source, pr.position NULLS LAST`,
      [playerId, season, week]
    );

    return result.rows.map(playerRankingFromDatabase);
  }

  /**
   * Get tiered rankings grouped by tier
   * Returns a map of tier number → players in that tier
   */
  async getTieredRankings(
    position: RankingPosition | null,
    source: RankingSource,
    season: number,
    week: number | null = null
  ): Promise<Map<number, PlayerRanking[]>> {
    const positionFilter = position === 'OVERALL' ? null : position;

    const result = await this.db.query(
      `SELECT
        pr.*,
        p.full_name as player_name,
        p.position as player_position,
        p.team
       FROM player_rankings pr
       JOIN players p ON p.id = pr.player_id
       WHERE pr.ranking_source = $1
         AND pr.season = $2
         AND ($3::INTEGER IS NULL OR pr.week = $3)
         AND ($4::VARCHAR IS NULL OR pr.position = $4)
         AND pr.tier IS NOT NULL
       ORDER BY pr.tier ASC, pr.rank ASC`,
      [source, season, week, positionFilter]
    );

    const tiers = new Map<number, PlayerRanking[]>();
    for (const row of result.rows) {
      const ranking = playerRankingFromDatabase(row);
      if (ranking.tier !== null) {
        if (!tiers.has(ranking.tier)) {
          tiers.set(ranking.tier, []);
        }
        tiers.get(ranking.tier)!.push(ranking);
      }
    }

    return tiers;
  }

  /**
   * Insert or update a ranking
   * Uses UPSERT to handle duplicate entries gracefully
   */
  async upsertRanking(data: CreateRankingData, client?: PoolClient): Promise<PlayerRanking> {
    const db = client || this.db;

    const result = await db.query(
      `INSERT INTO player_rankings (
        player_id, ranking_source, position, rank, tier, value, season, week
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (player_id, ranking_source, position, season, week)
      DO UPDATE SET
        rank = EXCLUDED.rank,
        tier = EXCLUDED.tier,
        value = EXCLUDED.value,
        updated_at = NOW()
      RETURNING *`,
      [
        data.playerId,
        data.rankingSource,
        data.rankingPosition || null,
        data.rank,
        data.tier || null,
        data.value || null,
        data.season,
        data.week || null,
      ]
    );

    // Fetch with player info
    const fullResult = await db.query(
      `SELECT
        pr.*,
        p.full_name as player_name,
        p.position as player_position,
        p.team
       FROM player_rankings pr
       JOIN players p ON p.id = pr.player_id
       WHERE pr.id = $1`,
      [result.rows[0].id]
    );

    return playerRankingFromDatabase(fullResult.rows[0]);
  }

  /**
   * Batch insert rankings for efficiency
   * Useful for seeding initial data or weekly updates
   */
  async upsertBatch(rankings: CreateRankingData[], client?: PoolClient): Promise<number> {
    const db = client || this.db;

    if (rankings.length === 0) return 0;

    // Build batch insert with ON CONFLICT
    const values: any[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const ranking of rankings) {
      placeholders.push(
        `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7})`
      );
      values.push(
        ranking.playerId,
        ranking.rankingSource,
        ranking.rankingPosition || null,
        ranking.rank,
        ranking.tier || null,
        ranking.value || null,
        ranking.season,
        ranking.week || null
      );
      paramIndex += 8;
    }

    const query = `
      INSERT INTO player_rankings (
        player_id, ranking_source, position, rank, tier, value, season, week
      ) VALUES ${placeholders.join(', ')}
      ON CONFLICT (player_id, ranking_source, position, season, week)
      DO UPDATE SET
        rank = EXCLUDED.rank,
        tier = EXCLUDED.tier,
        value = EXCLUDED.value,
        updated_at = NOW()
    `;

    const result = await db.query(query, values);
    logger.info(`Batch upserted ${result.rowCount} rankings`);

    return result.rowCount || 0;
  }

  /**
   * Delete rankings for a specific source/season/week
   * Useful for refresh operations
   */
  async deleteRankings(
    source: RankingSource,
    season: number,
    week: number | null = null
  ): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM player_rankings
       WHERE ranking_source = $1
         AND season = $2
         AND ($3::INTEGER IS NULL OR week = $3)`,
      [source, season, week]
    );

    return result.rowCount || 0;
  }

  /**
   * Get ranking statistics for a source
   * Returns count of ranked players by position
   */
  async getRankingStats(
    source: RankingSource,
    season: number,
    week: number | null = null
  ): Promise<{ position: string | null; count: number }[]> {
    const result = await this.db.query(
      `SELECT
        position,
        COUNT(*) as count
       FROM player_rankings
       WHERE ranking_source = $1
         AND season = $2
         AND ($3::INTEGER IS NULL OR week = $3)
       GROUP BY position
       ORDER BY position NULLS FIRST`,
      [source, season, week]
    );

    return result.rows.map((row) => ({
      position: row.position,
      count: Number(row.count) || 0,
    }));
  }
}
