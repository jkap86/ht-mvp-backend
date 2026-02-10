/**
 * Player News Repository
 * Stream A: Player News System (A1.3)
 */

import { Pool, PoolClient } from 'pg';
import {
  PlayerNews,
  PlayerNewsWithPlayer,
  playerNewsFromDatabase,
  createNewsHash,
  NewsType,
  ImpactLevel,
} from './news.model';

export interface CreateNewsData {
  playerId: number;
  title: string;
  summary?: string;
  content?: string;
  source: string;
  sourceUrl?: string;
  publishedAt: Date;
  newsType: NewsType;
  impactLevel: ImpactLevel;
}

export class NewsRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Create news item with automatic deduplication
   * @returns The created news item, or existing if duplicate detected
   */
  async createNews(data: CreateNewsData, client?: PoolClient): Promise<PlayerNews> {
    const db = client || this.db;

    // Create content hash for deduplication
    const contentHash = createNewsHash(data.title, data.publishedAt, data.source);

    // Check if this news already exists
    const existing = await db.query(
      `SELECT pn.*
       FROM player_news pn
       JOIN player_news_cache pnc ON pnc.news_id = pn.id
       WHERE pnc.content_hash = $1`,
      [contentHash]
    );

    if (existing.rows.length > 0) {
      return playerNewsFromDatabase(existing.rows[0]);
    }

    // Insert new news item
    const result = await db.query(
      `INSERT INTO player_news (
        player_id, title, summary, content, source, source_url,
        published_at, news_type, impact_level
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        data.playerId,
        data.title,
        data.summary || null,
        data.content || null,
        data.source,
        data.sourceUrl || null,
        data.publishedAt,
        data.newsType,
        data.impactLevel,
      ]
    );

    const news = playerNewsFromDatabase(result.rows[0]);

    // Insert cache entry
    await db.query(
      `INSERT INTO player_news_cache (content_hash, player_id, news_id)
       VALUES ($1, $2, $3)`,
      [contentHash, data.playerId, news.id]
    );

    return news;
  }

  /**
   * Get latest news for a specific player
   */
  async getNewsByPlayer(playerId: number, limit = 10): Promise<PlayerNews[]> {
    const result = await this.db.query(
      `SELECT * FROM player_news
       WHERE player_id = $1
       ORDER BY published_at DESC
       LIMIT $2`,
      [playerId, limit]
    );
    return result.rows.map(playerNewsFromDatabase);
  }

  /**
   * Get latest news across all players (league-wide feed)
   */
  async getLatestNews(limit = 50, offset = 0): Promise<PlayerNewsWithPlayer[]> {
    const result = await this.db.query(
      `SELECT
        pn.*,
        p.full_name as player_full_name,
        p.position as player_position,
        p.team as player_team,
        p.headshot_url as player_headshot_url
       FROM player_news pn
       JOIN players p ON p.id = pn.player_id
       ORDER BY pn.published_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return result.rows.map((row) => ({
      ...playerNewsFromDatabase(row),
      playerFullName: row.player_full_name,
      playerPosition: row.player_position,
      playerTeam: row.player_team,
      playerHeadshotUrl: row.player_headshot_url,
    }));
  }

  /**
   * Get breaking news (critical/high impact) since a given timestamp
   */
  async getBreakingNews(since: Date, limit = 20): Promise<PlayerNewsWithPlayer[]> {
    const result = await this.db.query(
      `SELECT
        pn.*,
        p.full_name as player_full_name,
        p.position as player_position,
        p.team as player_team,
        p.headshot_url as player_headshot_url
       FROM player_news pn
       JOIN players p ON p.id = pn.player_id
       WHERE pn.impact_level IN ('critical', 'high')
         AND pn.published_at > $1
       ORDER BY pn.published_at DESC
       LIMIT $2`,
      [since, limit]
    );

    return result.rows.map((row) => ({
      ...playerNewsFromDatabase(row),
      playerFullName: row.player_full_name,
      playerPosition: row.player_position,
      playerTeam: row.player_team,
      playerHeadshotUrl: row.player_headshot_url,
    }));
  }

  /**
   * Get news by type (e.g., all injury news)
   */
  async getNewsByType(
    newsType: NewsType,
    limit = 50,
    offset = 0
  ): Promise<PlayerNewsWithPlayer[]> {
    const result = await this.db.query(
      `SELECT
        pn.*,
        p.full_name as player_full_name,
        p.position as player_position,
        p.team as player_team,
        p.headshot_url as player_headshot_url
       FROM player_news pn
       JOIN players p ON p.id = pn.player_id
       WHERE pn.news_type = $1
       ORDER BY pn.published_at DESC
       LIMIT $2 OFFSET $3`,
      [newsType, limit, offset]
    );

    return result.rows.map((row) => ({
      ...playerNewsFromDatabase(row),
      playerFullName: row.player_full_name,
      playerPosition: row.player_position,
      playerTeam: row.player_team,
      playerHeadshotUrl: row.player_headshot_url,
    }));
  }

  /**
   * Get users who own a specific player (for targeted notifications)
   */
  async getUsersOwningPlayer(playerId: number, client?: PoolClient): Promise<string[]> {
    const db = client || this.db;
    const result = await db.query(
      `SELECT DISTINCT r.user_id
       FROM rosters r
       JOIN roster_players rp ON rp.roster_id = r.roster_id
       WHERE rp.player_id = $1`,
      [playerId]
    );
    return result.rows.map((row) => row.user_id);
  }

  /**
   * Delete old news items (cleanup job)
   */
  async deleteOldNews(olderThan: Date): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM player_news WHERE published_at < $1`,
      [olderThan]
    );
    return result.rowCount || 0;
  }
}
