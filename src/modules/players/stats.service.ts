/**
 * Player Stats Calculation Service
 * Stream B: Player Profiles & Stats (B1.3)
 */

import { Pool, PoolClient } from 'pg';
import { logger } from '../../config/logger.config';

export interface SeasonStats {
  playerId: number;
  season: string;
  gamesPlayed: number;
  // Passing
  passYd: number;
  passTd: number;
  passInt: number;
  passAtt: number;
  passCmp: number;
  // Rushing
  rushYd: number;
  rushTd: number;
  rushAtt: number;
  // Receiving
  rec: number;
  recYd: number;
  recTd: number;
  recTgt: number;
  // Fantasy points
  ptsStd: number;
  ptsHalfPpr: number;
  ptsPpr: number;
}

export interface GameLog {
  playerId: number;
  season: string;
  week: number;
  opponent: string | null;
  passYd: number;
  passTd: number;
  passInt: number;
  rushYd: number;
  rushTd: number;
  rec: number;
  recYd: number;
  recTd: number;
  ptsStd: number;
  ptsHalfPpr: number;
  ptsPpr: number;
  createdAt: Date;
}

export interface StatTrend {
  playerId: number;
  weeks: number[];
  points: number[]; // PPR points by week
  average: number;
  trend: 'up' | 'down' | 'stable'; // Last 3 weeks vs previous 3
}

export class StatsService {
  constructor(private readonly db: Pool) {}

  /**
   * Calculate season totals for a player
   */
  async calculateSeasonTotals(
    playerId: number,
    season: string,
    client?: PoolClient
  ): Promise<SeasonStats | null> {
    const db = client || this.db;

    const result = await db.query(
      `SELECT
        $1::integer as player_id,
        $2::text as season,
        COUNT(*) as games_played,
        COALESCE(SUM(pass_yd), 0) as pass_yd,
        COALESCE(SUM(pass_td), 0) as pass_td,
        COALESCE(SUM(pass_int), 0) as pass_int,
        COALESCE(SUM(pass_att), 0) as pass_att,
        COALESCE(SUM(pass_cmp), 0) as pass_cmp,
        COALESCE(SUM(rush_yd), 0) as rush_yd,
        COALESCE(SUM(rush_td), 0) as rush_td,
        COALESCE(SUM(rush_att), 0) as rush_att,
        COALESCE(SUM(rec), 0) as rec,
        COALESCE(SUM(rec_yd), 0) as rec_yd,
        COALESCE(SUM(rec_td), 0) as rec_td,
        COALESCE(SUM(rec_tgt), 0) as rec_tgt,
        COALESCE(SUM(pts_std), 0) as pts_std,
        COALESCE(SUM(pts_half_ppr), 0) as pts_half_ppr,
        COALESCE(SUM(pts_ppr), 0) as pts_ppr
       FROM player_stats
       WHERE player_id = $1 AND season = $2`,
      [playerId, season]
    );

    if (result.rows.length === 0 || result.rows[0].games_played === '0') {
      return null;
    }

    const row = result.rows[0];
    return {
      playerId: Number(row.player_id) || 0,
      season: row.season,
      gamesPlayed: Number(row.games_played) || 0,
      passYd: parseFloat(row.pass_yd) || 0,
      passTd: Number(row.pass_td) || 0,
      passInt: Number(row.pass_int) || 0,
      passAtt: Number(row.pass_att) || 0,
      passCmp: Number(row.pass_cmp) || 0,
      rushYd: parseFloat(row.rush_yd) || 0,
      rushTd: Number(row.rush_td) || 0,
      rushAtt: Number(row.rush_att) || 0,
      rec: Number(row.rec) || 0,
      recYd: parseFloat(row.rec_yd) || 0,
      recTd: Number(row.rec_td) || 0,
      recTgt: Number(row.rec_tgt) || 0,
      ptsStd: parseFloat(row.pts_std),
      ptsHalfPpr: parseFloat(row.pts_half_ppr),
      ptsPpr: parseFloat(row.pts_ppr),
    };
  }

  /**
   * Get recent game logs for a player
   */
  async getGameLogs(
    playerId: number,
    season: string,
    limit = 10,
    client?: PoolClient
  ): Promise<GameLog[]> {
    const db = client || this.db;

    const result = await db.query(
      `SELECT
        player_id,
        season,
        week,
        opponent,
        pass_yd,
        pass_td,
        pass_int,
        rush_yd,
        rush_td,
        rec,
        rec_yd,
        rec_td,
        pts_std,
        pts_half_ppr,
        pts_ppr,
        created_at
       FROM player_stats
       WHERE player_id = $1 AND season = $2
       ORDER BY week DESC
       LIMIT $3`,
      [playerId, season, limit]
    );

    return result.rows.map((row) => ({
      playerId: row.player_id,
      season: row.season,
      week: row.week,
      opponent: row.opponent,
      passYd: parseFloat(row.pass_yd) || 0,
      passTd: Number(row.pass_td) || 0,
      passInt: Number(row.pass_int) || 0,
      rushYd: parseFloat(row.rush_yd) || 0,
      rushTd: Number(row.rush_td) || 0,
      rec: Number(row.rec) || 0,
      recYd: parseFloat(row.rec_yd) || 0,
      recTd: Number(row.rec_td) || 0,
      ptsStd: parseFloat(row.pts_std) || 0,
      ptsHalfPpr: parseFloat(row.pts_half_ppr) || 0,
      ptsPpr: parseFloat(row.pts_ppr) || 0,
      createdAt: row.created_at,
    }));
  }

  /**
   * Get performance trend over recent weeks
   */
  async getStatTrends(
    playerId: number,
    season: string,
    weeks = 8,
    client?: PoolClient
  ): Promise<StatTrend | null> {
    const db = client || this.db;

    const result = await db.query(
      `SELECT week, pts_ppr
       FROM player_stats
       WHERE player_id = $1 AND season = $2
       ORDER BY week DESC
       LIMIT $3`,
      [playerId, season, weeks]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const weekNumbers = result.rows.map((r) => r.week).reverse();
    const points = result.rows.map((r) => parseFloat(r.pts_ppr) || 0).reverse();
    const average = points.reduce((sum, pts) => sum + pts, 0) / points.length;

    // Calculate trend (last 3 weeks vs previous 3)
    let trend: 'up' | 'down' | 'stable' = 'stable';
    if (points.length >= 6) {
      const last3 = points.slice(-3);
      const prev3 = points.slice(-6, -3);
      const last3Avg = last3.reduce((sum, pts) => sum + pts, 0) / 3;
      const prev3Avg = prev3.reduce((sum, pts) => sum + pts, 0) / 3;
      const change = ((last3Avg - prev3Avg) / prev3Avg) * 100;

      if (change > 10) trend = 'up';
      else if (change < -10) trend = 'down';
    }

    return {
      playerId,
      weeks: weekNumbers,
      points,
      average,
      trend,
    };
  }

  /**
   * Get average points over last N games
   */
  async getRecentAverage(
    playerId: number,
    season: string,
    games = 3,
    client?: PoolClient
  ): Promise<number> {
    const db = client || this.db;

    const result = await db.query(
      `SELECT AVG(pts_ppr) as avg_pts
       FROM (
         SELECT pts_ppr
         FROM player_stats
         WHERE player_id = $1 AND season = $2
         ORDER BY week DESC
         LIMIT $3
       ) recent`,
      [playerId, season, games]
    );

    return result.rows[0]?.avg_pts ? parseFloat(result.rows[0].avg_pts) : 0;
  }

  /**
   * Get player's weekly projection
   */
  async getWeeklyProjection(
    playerId: number,
    season: string,
    week: number,
    client?: PoolClient
  ): Promise<number | null> {
    const db = client || this.db;

    const result = await db.query(
      `SELECT pts_ppr
       FROM player_projections
       WHERE player_id = $1 AND season = $2 AND week = $3`,
      [playerId, season, week]
    );

    if (result.rows.length === 0) return null;
    return parseFloat(result.rows[0].pts_ppr) || null;
  }
}
