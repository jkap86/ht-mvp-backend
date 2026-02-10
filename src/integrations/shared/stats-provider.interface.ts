import {
  NflState,
  PlayerStatLine,
  GameSchedule,
  InjuryReport,
  PlayerMasterData,
} from './stats-provider.types';

/**
 * Stats provider interface
 * All stats providers must implement this contract to be compatible with the system.
 *
 * This interface abstracts away provider-specific details, allowing the application
 * to work with any stats provider (Sleeper, FantasyPros, SportRadar, etc.) without
 * changing business logic.
 */
export interface IStatsProvider {
  /** Provider identifier (e.g., 'sleeper', 'fantasypros') */
  readonly providerId: string;

  /**
   * Fetch current NFL state (season, week, phase)
   * @returns Current NFL season information
   */
  fetchNflState(): Promise<NflState>;

  /**
   * Fetch weekly player stats (actual game results)
   * @param season - NFL season year
   * @param week - Week number (1-18)
   * @returns Map of external_id -> stat line
   */
  fetchWeeklyStats(season: number, week: number): Promise<Record<string, PlayerStatLine>>;

  /**
   * Fetch weekly player projections
   * @param season - NFL season year
   * @param week - Week number (1-18)
   * @returns Map of external_id -> projected stat line
   */
  fetchWeeklyProjections(season: number, week: number): Promise<Record<string, PlayerStatLine>>;

  /**
   * Fetch player master data (roster, positions, teams)
   * @returns Map of external_id -> player data
   */
  fetchPlayerMasterData(): Promise<Record<string, PlayerMasterData>>;

  /**
   * Fetch game schedule for a week (optional)
   * @param season - NFL season year
   * @param week - Week number (1-18)
   * @returns Array of game schedule entries
   */
  fetchGameSchedule?(season: number, week: number): Promise<GameSchedule[]>;

  /**
   * Fetch injury reports (optional)
   * @returns Map of external_id -> injury report
   */
  fetchInjuryReports?(): Promise<Record<string, InjuryReport>>;
}
