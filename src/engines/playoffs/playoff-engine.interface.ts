import { PoolClient } from 'pg';
import { BracketType, SeriesAggregation, PlayoffBracket } from '../../modules/playoffs/playoff.model';

/**
 * Result of advancing from a playoff week
 */
export interface AdvanceResult {
  /** Whether any winners were advanced */
  advanced: boolean;
  /** Number of series completed this advancement */
  seriesCompleted: number;
  /** Whether the bracket is now complete */
  bracketComplete: boolean;
  /** Winner roster ID if bracket completed */
  winnerId?: number;
  /** Message describing what happened */
  message: string;
}

/**
 * Winner extracted from a series
 */
export interface SeriesWinner {
  rosterId: number;
  seed: number;
  bracketPosition: number;
  aggregatePoints: number;
}

/**
 * Loser extracted from a series (for 3rd place games)
 */
export interface SeriesLoser {
  rosterId: number;
  seed: number;
  bracketPosition: number;
  aggregatePoints: number;
}

/**
 * Context passed to all engine operations
 */
export interface PlayoffEngineContext {
  client: PoolClient;
  leagueId: number;
  season: number;
  bracket: PlayoffBracket;
}

/**
 * Playoff Engine Interface
 *
 * Each bracket type (WINNERS, CONSOLATION, THIRD_PLACE) has its own engine
 * that implements this interface. Engines are PURE - they compute decisions
 * only and delegate DB operations to the repository.
 */
export interface IPlayoffEngine {
  /**
   * The bracket type this engine handles
   */
  readonly bracketType: BracketType;

  /**
   * Advance winners from completed series in a given week.
   * Creates next round matchups or finalizes the bracket.
   *
   * @param ctx - Engine context with client, league, season, and bracket
   * @param week - The week to advance from
   * @returns Result describing what was advanced
   */
  advanceFromWeek(ctx: PlayoffEngineContext, week: number): Promise<AdvanceResult>;

  /**
   * Determine the winner of a series using aggregate scoring.
   * Tie-breaker: lower seed number (higher seed) wins.
   *
   * @param series - The series aggregation to determine winner for
   * @returns The roster ID of the winner
   */
  determineSeriesWinner(series: SeriesAggregation): number;

  /**
   * Get winners from a list of completed series.
   *
   * @param series - List of completed series
   * @returns Array of winners with their seeds and bracket positions
   */
  getSeriesWinners(series: SeriesAggregation[]): Promise<SeriesWinner[]>;

  /**
   * Get losers from a list of completed series (for 3rd place games).
   *
   * @param series - List of completed series
   * @returns Array of losers with their seeds and bracket positions
   */
  getSeriesLosers(series: SeriesAggregation[]): Promise<SeriesLoser[]>;
}
