/**
 * Socket payload DTOs for enhanced live scoring events
 * These payloads include actual score data to eliminate frontend HTTP refetches
 */

/**
 * Player score update within a matchup
 */
export interface PlayerScoreUpdate {
  playerId: number;
  rosterId: number;
  actualPoints: number;
  projectedPoints: number;
  status: 'playing' | 'completed' | 'not_started';
  lastUpdated: string; // ISO timestamp
}

/**
 * Complete matchup score snapshot
 * Includes team totals and player-level scores
 */
export interface MatchupScoreSnapshot {
  matchupId: number;
  roster1Id: number;
  roster2Id: number;
  team1Score: number;
  team2Score: number;
  team1Projected: number;
  team2Projected: number;
  status: 'pre_game' | 'in_progress' | 'final';
  players: PlayerScoreUpdate[];
  lastUpdated: string;
}

/**
 * Enhanced scores updated payload (v2)
 * Includes all matchup scores for a league/week
 */
export interface ScoresUpdatedV2Payload {
  leagueId: number;
  week: number;
  timestamp: string;
  matchups: MatchupScoreSnapshot[];
}

/**
 * Delta update payload
 * Only includes changes since last emission
 */
export interface ScoreDeltaPayload {
  leagueId: number;
  week: number;
  timestamp: string;
  changes: Array<{
    type: 'player_score' | 'projection_update' | 'status_change';
    playerId: number;
    matchupId: number;
    rosterId: number;
    previousValue?: number;
    newValue: number;
  }>;
}

/**
 * Response format for matchup snapshot (snake_case for API consistency)
 */
export interface MatchupScoreSnapshotResponse {
  matchup_id: number;
  roster1_id: number;
  roster2_id: number;
  team1_score: number;
  team2_score: number;
  team1_projected: number;
  team2_projected: number;
  status: 'pre_game' | 'in_progress' | 'final';
  players: Array<{
    player_id: number;
    roster_id: number;
    actual_points: number;
    projected_points: number;
    status: 'playing' | 'completed' | 'not_started';
    last_updated: string;
  }>;
  last_updated: string;
}

/**
 * Convert MatchupScoreSnapshot to response format
 */
export function matchupScoreSnapshotToResponse(
  snapshot: MatchupScoreSnapshot
): MatchupScoreSnapshotResponse {
  return {
    matchup_id: snapshot.matchupId,
    roster1_id: snapshot.roster1Id,
    roster2_id: snapshot.roster2Id,
    team1_score: snapshot.team1Score,
    team2_score: snapshot.team2Score,
    team1_projected: snapshot.team1Projected,
    team2_projected: snapshot.team2Projected,
    status: snapshot.status,
    players: snapshot.players.map((p) => ({
      player_id: p.playerId,
      roster_id: p.rosterId,
      actual_points: p.actualPoints,
      projected_points: p.projectedPoints,
      status: p.status,
      last_updated: p.lastUpdated,
    })),
    last_updated: snapshot.lastUpdated,
  };
}
