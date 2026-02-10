/**
 * Player Rankings Models
 * Phase 2 - Stream F: Player Rankings & Comparison
 *
 * TypeScript models for player ranking data
 * NO sleeper_id dependencies - uses internal player_id only
 */

export type RankingSource = 'consensus' | 'adp' | 'dynasty' | 'redraft';
export type RankingPosition = 'QB' | 'RB' | 'WR' | 'TE' | 'FLEX' | 'OVERALL';

export interface PlayerRanking {
  id: number;
  playerId: number;
  playerName?: string; // Joined from players table
  position?: string; // Player's actual position
  team?: string; // Player's team
  rankingSource: RankingSource;
  rankingPosition: RankingPosition | null; // Position filter for the ranking
  rank: number;
  tier: number | null;
  value: number | null;
  season: number;
  week: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateRankingData {
  playerId: number;
  rankingSource: RankingSource;
  rankingPosition?: RankingPosition | null;
  rank: number;
  tier?: number | null;
  value?: number | null;
  season: number;
  week?: number | null;
}

export interface PlayerComparison {
  players: PlayerRankingDetail[];
  categories: ComparisonCategory[];
}

export interface PlayerRankingDetail extends PlayerRanking {
  seasonStats?: SeasonStats;
  projections?: WeeklyProjection;
  trendingData?: {
    addsLast24h: number;
    dropsLast24h: number;
    ownershipPercentage: number;
    trendDirection: 'up' | 'down' | 'neutral';
  };
  recentGames?: GameLog[];
}

export interface ComparisonCategory {
  name: string;
  unit: string;
  values: { playerId: number; value: number | string; isHighlight: boolean }[];
}

export interface SeasonStats {
  gamesPlayed: number;
  passingYards?: number;
  passingTds?: number;
  rushingYards?: number;
  rushingTds?: number;
  receivingYards?: number;
  receivingTds?: number;
  receptions?: number;
  ptsPpr: number;
}

export interface WeeklyProjection {
  week: number;
  projectedPoints: number;
  confidence?: 'low' | 'medium' | 'high';
}

export interface GameLog {
  week: number;
  opponent: string;
  points: number;
  stats: Partial<SeasonStats>;
}

/**
 * Map database row to PlayerRanking model
 */
export function playerRankingFromDatabase(row: any): PlayerRanking {
  return {
    id: row.id,
    playerId: row.player_id,
    playerName: row.player_name || row.full_name,
    position: row.player_position || row.position,
    team: row.team,
    rankingSource: row.ranking_source,
    rankingPosition: row.position as RankingPosition | null,
    rank: row.rank,
    tier: row.tier,
    value: row.value ? parseFloat(row.value) : null,
    season: row.season,
    week: row.week,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * Convert to API response format
 */
export function playerRankingToResponse(ranking: PlayerRanking) {
  return {
    id: ranking.id,
    playerId: ranking.playerId,
    playerName: ranking.playerName,
    position: ranking.position,
    team: ranking.team,
    rankingSource: ranking.rankingSource,
    rankingPosition: ranking.rankingPosition,
    rank: ranking.rank,
    tier: ranking.tier,
    value: ranking.value,
    season: ranking.season,
    week: ranking.week,
    updatedAt: ranking.updatedAt.toISOString(),
  };
}
