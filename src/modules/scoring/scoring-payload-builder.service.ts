import { Pool, PoolClient } from 'pg';
import {
  MatchupScoreSnapshot,
  PlayerScoreUpdate,
  ScoresUpdatedV2Payload,
  ScoreDeltaPayload,
} from './dto/socket-scoring-payloads.dto';
import { MatchupsRepository } from '../matchups/matchups.repository';
import { LineupsRepository } from '../lineups/lineups.repository';
import { logger } from '../../config/logger.config';

/**
 * Service for building enhanced socket payloads with actual score data.
 * Eliminates need for frontend HTTP refetches by including scores in socket events.
 */
export class ScoringPayloadBuilderService {
  constructor(
    private readonly db: Pool,
    private readonly matchupsRepo: MatchupsRepository,
    private readonly lineupsRepo: LineupsRepository
  ) {}

  /**
   * Build a complete matchup score snapshot.
   * Includes team totals and player-level scores.
   *
   * @param matchupId - The matchup ID
   * @param client - Optional database client for transaction support
   * @returns Complete matchup snapshot with scores
   */
  async buildMatchupSnapshot(
    matchupId: number,
    client?: PoolClient
  ): Promise<MatchupScoreSnapshot> {
    const db = client || this.db;

    // Get matchup details
    const matchup = await this.matchupsRepo.findById(matchupId);
    if (!matchup) {
      throw new Error(`Matchup ${matchupId} not found`);
    }

    // Get lineups for both rosters
    const [lineup1, lineup2] = await Promise.all([
      this.lineupsRepo.findByRosterAndWeek(matchup.roster1Id, matchup.season, matchup.week),
      this.lineupsRepo.findByRosterAndWeek(matchup.roster2Id, matchup.season, matchup.week),
    ]);

    // Get player scores from lineups
    const players = await this.getPlayerScoresForMatchup(
      matchup.roster1Id,
      matchup.roster2Id,
      matchup.season,
      matchup.week,
      lineup1?.lineup,
      lineup2?.lineup,
      db
    );

    // Determine matchup status
    const status = matchup.isFinal
      ? 'final'
      : lineup1?.totalPointsLive !== null || lineup2?.totalPointsLive !== null
        ? 'in_progress'
        : 'pre_game';

    return {
      matchupId: matchup.id,
      roster1Id: matchup.roster1Id,
      roster2Id: matchup.roster2Id,
      team1Score: lineup1?.totalPointsLive ?? 0,
      team2Score: lineup2?.totalPointsLive ?? 0,
      team1Projected: lineup1?.totalPointsProjectedLive ?? 0,
      team2Projected: lineup2?.totalPointsProjectedLive ?? 0,
      status,
      players,
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Build full league scores v2 payload.
   * Includes all matchups for a league/week with complete score data.
   *
   * @param leagueId - The league ID
   * @param season - The season year
   * @param week - The week number
   * @param client - Optional database client for transaction support
   * @returns Complete scores v2 payload
   */
  async buildLeagueScoresV2(
    leagueId: number,
    season: number,
    week: number,
    client?: PoolClient
  ): Promise<ScoresUpdatedV2Payload> {
    const matchups = await this.matchupsRepo.findByLeagueAndWeek(leagueId, season, week);

    // Build snapshots for all matchups in parallel
    const matchupSnapshots = await Promise.all(
      matchups.map((matchup) => this.buildMatchupSnapshot(matchup.id, client))
    );

    return {
      leagueId,
      week,
      timestamp: new Date().toISOString(),
      matchups: matchupSnapshots,
    };
  }

  /**
   * Build a delta payload showing only what changed.
   * Compares previous and new states to extract differences.
   *
   * @param previousState - Previous matchup snapshot
   * @param newState - New matchup snapshot
   * @returns Delta payload with changes only
   */
  async buildScoreDelta(
    previousState: MatchupScoreSnapshot,
    newState: MatchupScoreSnapshot
  ): Promise<ScoreDeltaPayload> {
    const changes: ScoreDeltaPayload['changes'] = [];

    // Compare player scores
    const prevPlayerMap = new Map(previousState.players.map((p) => [p.playerId, p]));

    for (const newPlayer of newState.players) {
      const prevPlayer = prevPlayerMap.get(newPlayer.playerId);

      // Player score changed
      if (!prevPlayer || prevPlayer.actualPoints !== newPlayer.actualPoints) {
        changes.push({
          type: 'player_score',
          playerId: newPlayer.playerId,
          matchupId: newState.matchupId,
          rosterId: newPlayer.rosterId,
          previousValue: prevPlayer?.actualPoints,
          newValue: newPlayer.actualPoints,
        });
      }

      // Projection changed
      if (!prevPlayer || prevPlayer.projectedPoints !== newPlayer.projectedPoints) {
        changes.push({
          type: 'projection_update',
          playerId: newPlayer.playerId,
          matchupId: newState.matchupId,
          rosterId: newPlayer.rosterId,
          previousValue: prevPlayer?.projectedPoints,
          newValue: newPlayer.projectedPoints,
        });
      }

      // Status changed
      if (!prevPlayer || prevPlayer.status !== newPlayer.status) {
        changes.push({
          type: 'status_change',
          playerId: newPlayer.playerId,
          matchupId: newState.matchupId,
          rosterId: newPlayer.rosterId,
          newValue: 0, // Status is a string, but we need a number for the interface
        });
      }
    }

    // Extract league ID and week from matchup context
    // Note: We need to fetch these from the matchup if not available in snapshot
    const matchup = await this.matchupsRepo.findById(newState.matchupId);

    return {
      leagueId: matchup?.leagueId ?? 0,
      week: matchup?.week ?? 0,
      timestamp: new Date().toISOString(),
      changes,
    };
  }

  /**
   * Get player scores for a matchup.
   * Fetches actual and projected points for all players in both lineups.
   *
   * @private
   */
  private async getPlayerScoresForMatchup(
    roster1Id: number,
    roster2Id: number,
    season: number,
    week: number,
    lineup1: any,
    lineup2: any,
    db: PoolClient | Pool
  ): Promise<PlayerScoreUpdate[]> {
    if (!lineup1 && !lineup2) {
      return [];
    }

    // Collect all player IDs from both lineups
    const playerIds: number[] = [];
    const playerRosterMap = new Map<number, number>();

    const addPlayersFromLineup = (lineup: any, rosterId: number) => {
      if (!lineup) return;
      for (const slot of Object.keys(lineup)) {
        const playerSlot = lineup[slot];
        if (Array.isArray(playerSlot)) {
          for (const playerId of playerSlot) {
            if (typeof playerId === 'number') {
              playerIds.push(playerId);
              playerRosterMap.set(playerId, rosterId);
            }
          }
        }
      }
    };

    addPlayersFromLineup(lineup1, roster1Id);
    addPlayersFromLineup(lineup2, roster2Id);

    if (playerIds.length === 0) {
      return [];
    }

    // Query player stats for the week
    // Join with player_stats and player_projections to get actual and projected points
    const result = await db.query(
      `SELECT
        ps.player_id,
        COALESCE(ps.points, 0) as actual_points,
        COALESCE(pp.points, 0) as projected_points,
        CASE
          WHEN ps.points IS NOT NULL THEN 'completed'
          ELSE 'not_started'
        END as status
       FROM unnest($1::int[]) AS player_id
       LEFT JOIN player_stats ps ON ps.player_id = player_id AND ps.season = $2 AND ps.week = $3
       LEFT JOIN player_projections pp ON pp.player_id = player_id AND pp.season = $2 AND pp.week = $3`,
      [playerIds, season, week]
    );

    // Map results to PlayerScoreUpdate
    return result.rows.map((row) => ({
      playerId: row.player_id,
      rosterId: playerRosterMap.get(row.player_id) ?? 0,
      actualPoints: parseFloat(row.actual_points) || 0,
      projectedPoints: parseFloat(row.projected_points) || 0,
      status: row.status as 'playing' | 'completed' | 'not_started',
      lastUpdated: new Date().toISOString(),
    }));
  }
}
