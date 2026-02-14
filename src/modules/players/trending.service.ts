/**
 * Trending Players & Ownership Tracking Service
 * Stream E: Waiver Wire Enhancements (E1.2)
 */

import { Pool, PoolClient } from 'pg';
import { logger } from '../../config/logger.config';
import { runInTransaction } from '../../shared/transaction-runner';
import { IStatsProvider } from '../../integrations/shared/stats-provider.interface';

export interface TrendingPlayer {
  playerId: number;
  playerName: string;
  position: string;
  team: string;
  addsLast24h: number;
  dropsLast24h: number;
  addsLastWeek: number;
  dropsLastWeek: number;
  ownershipPercentage: number;
  trendingScore: number;
  trendDirection: 'up' | 'down' | 'neutral';
  recentPointsAvg: number | null;
  projectedPointsNext: number | null;
}

export class TrendingService {
  constructor(
    private readonly db: Pool,
    private readonly statsProvider?: IStatsProvider
  ) {}

  /**
   * Calculate and update trending players
   * Run this as a background job (daily or hourly)
   */
  async updateTrendingPlayers(): Promise<{ updated: number }> {
    // Fetch current season dynamically from NFL state
    let currentSeason: string;
    if (this.statsProvider) {
      const nflState = await this.statsProvider.fetchNflState();
      currentSeason = nflState.season.toString();
    } else {
      // Fallback: query from player_stats most recent season
      const seasonResult = await this.db.query(
        `SELECT MAX(season) as season FROM player_stats`
      );
      currentSeason = seasonResult.rows[0]?.season?.toString() || new Date().getFullYear().toString();
      logger.warn('TrendingService: No stats provider configured, falling back to DB season lookup');
    }

    return await runInTransaction(this.db, async (client) => {
      // Get transaction counts for last 24h and last week
      const transactions = await this.getRecentTransactions(client);

      // Calculate ownership percentages
      const ownership = await this.calculateOwnership(client);

      // Get recent performance data
      const performance = await this.getRecentPerformance(client, currentSeason);

      let updated = 0;

      // Update trending_players table
      for (const [playerId, data] of Object.entries(transactions)) {
        const playerIdNum = Number(playerId) || 0;
        const ownershipPct = ownership.get(playerIdNum) || 0;
        const perf = performance.get(playerIdNum);

        // Calculate trending score
        // Formula: (adds - drops) with exponential decay and ownership weighting
        const addVelocity = data.adds24h * 2 + data.addsWeek;
        const dropVelocity = data.drops24h * 2 + data.dropsWeek;
        const netVelocity = addVelocity - dropVelocity;

        // Score: net velocity with ownership multiplier
        const ownershipMultiplier = 1 + (ownershipPct / 100) * 0.5; // Up to 1.5x for highly owned
        const trendingScore = netVelocity * ownershipMultiplier;

        // Determine trend direction
        let trendDirection: 'up' | 'down' | 'neutral' = 'neutral';
        if (trendingScore > 5) trendDirection = 'up';
        else if (trendingScore < -5) trendDirection = 'down';

        await client.query(
          `INSERT INTO trending_players (
            player_id, adds_last_24h, drops_last_24h, adds_last_week, drops_last_week,
            total_rostered, ownership_percentage, trending_score, trend_direction,
            recent_points_avg, projected_points_next, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
          ON CONFLICT (player_id) DO UPDATE SET
            adds_last_24h = $2,
            drops_last_24h = $3,
            adds_last_week = $4,
            drops_last_week = $5,
            total_rostered = $6,
            ownership_percentage = $7,
            trending_score = $8,
            trend_direction = $9,
            recent_points_avg = $10,
            projected_points_next = $11,
            updated_at = NOW()`,
          [
            playerIdNum,
            data.adds24h,
            data.drops24h,
            data.addsWeek,
            data.dropsWeek,
            ownership.get(playerIdNum) || 0,
            ownershipPct,
            trendingScore,
            trendDirection,
            perf?.recentAvg || null,
            perf?.nextProjection || null,
          ]
        );

        updated++;
      }

      logger.info(`Updated ${updated} trending players`);
      return { updated };
    });
  }

  /**
   * Get top trending players (hot pickups)
   */
  async getHotPickups(limit = 20): Promise<TrendingPlayer[]> {
    const result = await this.db.query(
      `SELECT
        tp.*,
        p.full_name as player_name,
        p.position,
        p.team
       FROM trending_players tp
       JOIN players p ON p.id = tp.player_id
       WHERE tp.trend_direction = 'up'
       ORDER BY tp.trending_score DESC
       LIMIT $1`,
      [limit]
    );

    return result.rows.map(this.mapToTrendingPlayer);
  }

  /**
   * Get cooling players (high drops)
   */
  async getCoolingPlayers(limit = 20): Promise<TrendingPlayer[]> {
    const result = await this.db.query(
      `SELECT
        tp.*,
        p.full_name as player_name,
        p.position,
        p.team
       FROM trending_players tp
       JOIN players p ON p.id = tp.player_id
       WHERE tp.trend_direction = 'down'
       ORDER BY tp.trending_score ASC
       LIMIT $1`,
      [limit]
    );

    return result.rows.map(this.mapToTrendingPlayer);
  }

  /**
   * Get ownership percentage for a player
   */
  async getOwnershipPercentage(playerId: number): Promise<number> {
    const result = await this.db.query(
      `SELECT ownership_percentage FROM trending_players WHERE player_id = $1`,
      [playerId]
    );

    return result.rows[0]?.ownership_percentage || 0;
  }

  /**
   * Get recent transaction counts
   */
  private async getRecentTransactions(
    client: PoolClient
  ): Promise<Record<number, { adds24h: number; drops24h: number; addsWeek: number; dropsWeek: number }>> {
    const now = new Date();
    const day24hAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const week7dAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const result = await client.query(
      `SELECT
        player_id,
        COUNT(*) FILTER (WHERE transaction_type = 'add' AND created_at > $1) as adds_24h,
        COUNT(*) FILTER (WHERE transaction_type = 'drop' AND created_at > $1) as drops_24h,
        COUNT(*) FILTER (WHERE transaction_type = 'add' AND created_at > $2) as adds_week,
        COUNT(*) FILTER (WHERE transaction_type = 'drop' AND created_at > $2) as drops_week
       FROM roster_transactions
       WHERE created_at > $2
       GROUP BY player_id`,
      [day24hAgo, week7dAgo]
    );

    const transactions: Record<number, any> = {};
    for (const row of result.rows) {
      transactions[row.player_id] = {
        adds24h: Number(row.adds_24h) || 0,
        drops24h: Number(row.drops_24h) || 0,
        addsWeek: Number(row.adds_week) || 0,
        dropsWeek: Number(row.drops_week) || 0,
      };
    }

    return transactions;
  }

  /**
   * Calculate ownership percentages
   */
  private async calculateOwnership(client: PoolClient): Promise<Map<number, number>> {
    // Count total active rosters
    const totalResult = await client.query(
      `SELECT COUNT(DISTINCT roster_id) as total FROM rosters WHERE active = true`
    );
    const totalRosters = Number(totalResult.rows[0]?.total) || 0;

    if (totalRosters === 0) return new Map();

    // Count rosters owning each player
    const result = await client.query(
      `SELECT player_id, COUNT(DISTINCT roster_id) as count
       FROM roster_players
       GROUP BY player_id`
    );

    const ownership = new Map<number, number>();
    for (const row of result.rows) {
      const pct = ((Number(row.count) || 0) / totalRosters) * 100;
      ownership.set(row.player_id, parseFloat(pct.toFixed(2)));
    }

    return ownership;
  }

  /**
   * Get recent performance data
   */
  private async getRecentPerformance(
    client: PoolClient,
    currentSeason: string
  ): Promise<Map<number, { recentAvg: number; nextProjection: number | null }>> {

    // Get last 3 games average
    const statsResult = await client.query(
      `SELECT player_id, AVG(pts_ppr) as avg_pts
       FROM (
         SELECT player_id, pts_ppr, ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY week DESC) as rn
         FROM player_stats
         WHERE season = $1
       ) recent
       WHERE rn <= 3
       GROUP BY player_id`,
      [currentSeason]
    );

    const performance = new Map<number, any>();
    for (const row of statsResult.rows) {
      performance.set(row.player_id, {
        recentAvg: parseFloat(row.avg_pts),
        nextProjection: null,
      });
    }

    return performance;
  }

  /**
   * Map database row to TrendingPlayer
   */
  private mapToTrendingPlayer(row: any): TrendingPlayer {
    return {
      playerId: row.player_id,
      playerName: row.player_name,
      position: row.position,
      team: row.team,
      addsLast24h: row.adds_last_24h,
      dropsLast24h: row.drops_last_24h,
      addsLastWeek: row.adds_last_week,
      dropsLastWeek: row.drops_last_week,
      ownershipPercentage: parseFloat(row.ownership_percentage),
      trendingScore: parseFloat(row.trending_score),
      trendDirection: row.trend_direction,
      recentPointsAvg: row.recent_points_avg ? parseFloat(row.recent_points_avg) : null,
      projectedPointsNext: row.projected_points_next ? parseFloat(row.projected_points_next) : null,
    };
  }
}
