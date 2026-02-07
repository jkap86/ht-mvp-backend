import axios from 'axios';
import { logger } from '../../config/env.config';

/**
 * Game status for a team's current game
 */
export interface TeamGameStatus {
  gameId: string;
  kickoff: number; // Unix timestamp
  opponent: string;
  timeLeftSeconds: number; // Seconds remaining in game (0-3600)
  isInProgress: boolean;
  isComplete: boolean;
}

/**
 * Response from Sleeper's GraphQL scores endpoint
 */
interface SleeperScoresResponse {
  data: {
    scores: Array<{
      game_id: string;
      start_time: number;
      status: string;
      metadata: {
        away_team: string;
        home_team: string;
        time_remaining?: string;
        quarter_num: number | '';
        is_in_progress: boolean;
        away_score?: number;
        home_score?: number;
      };
    }>;
  };
}

// Total game time = 60 minutes = 3600 seconds
const TOTAL_GAME_SECONDS = 3600;

/**
 * Convert time remaining string and quarter to total seconds left in game
 * @param timeRemaining - Time remaining in current quarter (e.g., "12:34")
 * @param quarterNum - Current quarter number (1-4) or '' if not started
 * @returns Total seconds remaining in the game
 */
function timeStringToSeconds(
  timeRemaining: string | undefined,
  quarterNum: number | ''
): number {
  if (!timeRemaining || quarterNum === '') {
    return TOTAL_GAME_SECONDS; // Game not started
  }

  const parts = timeRemaining.split(':');
  const minutes = parseInt(parts[0], 10) || 0;
  const seconds = parseInt(parts[1], 10) || 0;

  // Time in current quarter + remaining quarters
  // Each quarter is 15 minutes = 900 seconds
  const quarterTimeLeft = minutes * 60 + seconds;
  const remainingQuarters = 4 - quarterNum;

  return quarterTimeLeft + remainingQuarters * 15 * 60;
}

/**
 * Service for fetching live game progress from Sleeper's GraphQL API
 */
export class GameProgressService {
  private readonly graphqlUrl = 'https://sleeper.com/graphql';

  /**
   * Fetch game status for all games in a given week
   * @returns Map of team abbreviation -> TeamGameStatus
   */
  async getWeekGameStatus(
    season: number,
    week: number,
    seasonType: 'regular' | 'post' = 'regular'
  ): Promise<Map<string, TeamGameStatus>> {
    const teamsMap = new Map<string, TeamGameStatus>();

    try {
      const graphqlQuery = {
        query: `
          query batch_scores {
            scores(
              sport: "nfl",
              season_type: "${seasonType}",
              season: "${season}",
              week: ${week}
            ) {
              game_id
              metadata
              status
              start_time
            }
          }
        `,
      };

      const response = await axios.post<SleeperScoresResponse>(
        this.graphqlUrl,
        graphqlQuery,
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 10000, // 10 second timeout
        }
      );

      const games = response.data?.data?.scores || [];

      for (const game of games) {
        const { metadata, status, start_time, game_id } = game;
        const isComplete = status === 'complete';
        const isInProgress = metadata.is_in_progress === true;

        const timeLeftSeconds = isComplete
          ? 0
          : isInProgress
            ? timeStringToSeconds(metadata.time_remaining, metadata.quarter_num)
            : TOTAL_GAME_SECONDS;

        // Away team entry
        teamsMap.set(metadata.away_team, {
          gameId: game_id,
          kickoff: start_time,
          opponent: `@ ${metadata.home_team}`,
          timeLeftSeconds,
          isInProgress,
          isComplete,
        });

        // Home team entry
        teamsMap.set(metadata.home_team, {
          gameId: game_id,
          kickoff: start_time,
          opponent: `vs ${metadata.away_team}`,
          timeLeftSeconds,
          isInProgress,
          isComplete,
        });
      }

      logger.info(`Fetched game status for ${games.length} games (${teamsMap.size} teams)`);
    } catch (error) {
      logger.error(`Failed to fetch game status from Sleeper: ${error}`);
      // Return empty map on error - callers should handle gracefully
    }

    return teamsMap;
  }

  /**
   * Get the percentage of game remaining (0.0 = finished, 1.0 = not started)
   */
  getPercentRemaining(status: TeamGameStatus): number {
    if (status.isComplete) return 0;
    if (!status.isInProgress) return 1; // Game hasn't started yet
    return status.timeLeftSeconds / TOTAL_GAME_SECONDS;
  }

  /**
   * Calculate projected final points for a player based on game progress
   * Formula: projectedFinal = actualPoints + (originalProjection × gamePercentRemaining)
   *
   * @param actualPoints - Points scored so far
   * @param projectedPoints - Original full-game projection
   * @param percentRemaining - Fraction of game remaining (0.0 to 1.0)
   * @returns Projected final points
   */
  calculateProjectedFinal(
    actualPoints: number,
    projectedPoints: number,
    percentRemaining: number
  ): number {
    // If game is complete, just return actual
    if (percentRemaining <= 0) return actualPoints;

    // If game hasn't started, return projection
    if (percentRemaining >= 1) return projectedPoints;

    // Mid-game: actual + remaining projection
    return actualPoints + projectedPoints * percentRemaining;
  }
}
