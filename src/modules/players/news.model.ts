/**
 * Player News Models
 * Stream A: Player News System
 */

export type NewsType = 'injury' | 'transaction' | 'performance' | 'depth_chart' | 'general';
export type ImpactLevel = 'critical' | 'high' | 'normal' | 'low';

export interface PlayerNews {
  id: number;
  playerId: number;
  title: string;
  summary: string | null;
  content: string | null;
  source: string;
  sourceUrl: string | null;
  publishedAt: Date;
  newsType: NewsType;
  impactLevel: ImpactLevel;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlayerNewsWithPlayer extends PlayerNews {
  playerFullName: string;
  playerPosition: string | null;
  playerTeam: string | null;
  playerHeadshotUrl: string | null;
}

export function playerNewsFromDatabase(row: any): PlayerNews {
  return {
    id: row.id,
    playerId: row.player_id,
    title: row.title,
    summary: row.summary,
    content: row.content,
    source: row.source,
    sourceUrl: row.source_url,
    publishedAt: new Date(row.published_at),
    newsType: row.news_type as NewsType,
    impactLevel: row.impact_level as ImpactLevel,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function playerNewsToResponse(news: PlayerNews | PlayerNewsWithPlayer) {
  const response: any = {
    id: news.id,
    player_id: news.playerId,
    title: news.title,
    summary: news.summary,
    content: news.content,
    source: news.source,
    source_url: news.sourceUrl,
    published_at: news.publishedAt.toISOString(),
    news_type: news.newsType,
    impact_level: news.impactLevel,
    created_at: news.createdAt.toISOString(),
    updated_at: news.updatedAt.toISOString(),
  };

  // Add player details if available
  if ('playerFullName' in news) {
    response.player = {
      full_name: news.playerFullName,
      position: news.playerPosition,
      team: news.playerTeam,
      headshot_url: news.playerHeadshotUrl,
    };
  }

  return response;
}

/**
 * Create content hash for deduplication
 */
export function createNewsHash(title: string, publishedAt: Date, source: string): string {
  const crypto = require('crypto');
  const content = `${title}|${publishedAt.toISOString()}|${source}`;
  return crypto.createHash('sha256').update(content).digest('hex');
}
