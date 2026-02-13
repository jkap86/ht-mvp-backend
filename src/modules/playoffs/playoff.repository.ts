import { Pool, PoolClient } from 'pg';
import {
  PlayoffBracket,
  PlayoffSeed,
  playoffBracketFromDatabase,
  playoffSeedFromDatabase,
  PlayoffStatus,
  BracketType,
  ConsolationType,
  SeedBracketType,
  SeriesAggregation,
} from './playoff.model';

export class PlayoffRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Create a new playoff bracket
   */
  async createBracket(
    leagueId: number,
    season: number,
    playoffTeams: number,
    totalRounds: number,
    startWeek: number,
    championshipWeek: number,
    enableThirdPlace: boolean = false,
    consolationType: ConsolationType = 'NONE',
    consolationTeams: number | null = null,
    weeksByRound: number[] | null = null,
    client?: PoolClient,
    leagueSeasonId?: number
  ): Promise<PlayoffBracket> {
    const db = client || this.db;
    const result = await db.query(
      `INSERT INTO playoff_brackets
       (league_id, season, playoff_teams, total_rounds, start_week, championship_week, status,
        enable_third_place, consolation_type, consolation_teams, weeks_by_round, league_season_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        leagueId,
        season,
        playoffTeams,
        totalRounds,
        startWeek,
        championshipWeek,
        enableThirdPlace,
        consolationType,
        consolationTeams,
        weeksByRound ? JSON.stringify(weeksByRound) : null,
        leagueSeasonId || null,
      ]
    );
    return playoffBracketFromDatabase(result.rows[0]);
  }

  /**
   * Find bracket by league and season
   */
  async findByLeagueSeason(
    leagueId: number,
    season: number,
    leagueSeasonId?: number
  ): Promise<PlayoffBracket | null> {
    if (leagueSeasonId) {
      const result = await this.db.query(
        'SELECT * FROM playoff_brackets WHERE league_season_id = $1',
        [leagueSeasonId]
      );
      if (result.rows.length === 0) return null;
      return playoffBracketFromDatabase(result.rows[0]);
    }
    const result = await this.db.query(
      'SELECT * FROM playoff_brackets WHERE league_id = $1 AND season = $2',
      [leagueId, season]
    );
    if (result.rows.length === 0) return null;
    return playoffBracketFromDatabase(result.rows[0]);
  }

  /**
   * Find bracket by league_season_id (preferred for season-scoped queries)
   */
  async findByLeagueSeasonId(leagueSeasonId: number): Promise<PlayoffBracket | null> {
    const result = await this.db.query(
      'SELECT * FROM playoff_brackets WHERE league_season_id = $1',
      [leagueSeasonId]
    );
    if (result.rows.length === 0) return null;
    return playoffBracketFromDatabase(result.rows[0]);
  }

  /**
   * Find bracket by ID
   */
  async findById(bracketId: number): Promise<PlayoffBracket | null> {
    const result = await this.db.query('SELECT * FROM playoff_brackets WHERE id = $1', [bracketId]);
    if (result.rows.length === 0) return null;
    return playoffBracketFromDatabase(result.rows[0]);
  }

  /**
   * Update bracket status
   */
  async updateStatus(bracketId: number, status: PlayoffStatus, client?: PoolClient): Promise<void> {
    const db = client || this.db;
    await db.query(
      'UPDATE playoff_brackets SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [status, bracketId]
    );
  }

  /**
   * Set champion roster ID (does NOT set status to completed - use finalizeBracketIfComplete)
   */
  async setChampion(
    bracketId: number,
    championRosterId: number,
    client?: PoolClient
  ): Promise<void> {
    const db = client || this.db;
    await db.query(
      `UPDATE playoff_brackets
       SET champion_roster_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [championRosterId, bracketId]
    );
  }

  /**
   * Check if all required winners are set and mark bracket as completed if so.
   * Returns true if bracket was marked completed.
   */
  async finalizeBracketIfComplete(bracketId: number, client?: PoolClient): Promise<boolean> {
    const db = client || this.db;

    // Get current bracket state
    const result = await db.query(
      `SELECT champion_roster_id, enable_third_place, third_place_roster_id,
              consolation_type, consolation_winner_roster_id, status
       FROM playoff_brackets WHERE id = $1`,
      [bracketId]
    );

    if (result.rows.length === 0) return false;

    const bracket = result.rows[0];

    // Already completed
    if (bracket.status === 'completed') return true;

    // Check if all required winners are set
    const hasChampion = bracket.champion_roster_id !== null;
    const needsThirdPlace = bracket.enable_third_place === true;
    const hasThirdPlace = bracket.third_place_roster_id !== null;
    const needsConsolation = bracket.consolation_type === 'CONSOLATION';
    const hasConsolation = bracket.consolation_winner_roster_id !== null;

    // All required winners must be present
    const isComplete =
      hasChampion && (!needsThirdPlace || hasThirdPlace) && (!needsConsolation || hasConsolation);

    if (isComplete) {
      await db.query(
        `UPDATE playoff_brackets SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [bracketId]
      );
      return true;
    }

    return false;
  }

  /**
   * Delete bracket (for regenerating)
   */
  async deleteBracket(bracketId: number, client?: PoolClient): Promise<void> {
    const db = client || this.db;
    // Seeds are deleted via CASCADE
    await db.query('DELETE FROM playoff_brackets WHERE id = $1', [bracketId]);
  }

  /**
   * Create playoff seeds
   */
  async createSeeds(
    bracketId: number,
    seeds: Array<{
      rosterId: number;
      seed: number;
      regularSeasonRecord: string;
      pointsFor: number;
      hasBye: boolean;
      bracketType?: SeedBracketType;
    }>,
    client?: PoolClient
  ): Promise<PlayoffSeed[]> {
    const db = client || this.db;
    const createdSeeds: PlayoffSeed[] = [];

    for (const seed of seeds) {
      const bracketType = seed.bracketType || 'WINNERS';
      const result = await db.query(
        `INSERT INTO playoff_seeds
         (bracket_id, roster_id, seed, regular_season_record, points_for, has_bye, bracket_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          bracketId,
          seed.rosterId,
          seed.seed,
          seed.regularSeasonRecord,
          seed.pointsFor,
          seed.hasBye,
          bracketType,
        ]
      );
      createdSeeds.push(playoffSeedFromDatabase(result.rows[0]));
    }

    return createdSeeds;
  }

  /**
   * Get seeds for a bracket with team info (defaults to WINNERS for backwards compatibility)
   */
  async getSeeds(bracketId: number): Promise<PlayoffSeed[]> {
    const result = await this.db.query(
      `SELECT ps.*, r.settings->>'team_name' as team_name, r.user_id
       FROM playoff_seeds ps
       JOIN rosters r ON ps.roster_id = r.id
       WHERE ps.bracket_id = $1 AND ps.bracket_type = 'WINNERS'
       ORDER BY ps.seed`,
      [bracketId]
    );
    return result.rows.map(playoffSeedFromDatabase);
  }

  /**
   * Get seeds by bracket type
   */
  async getSeedsByType(bracketId: number, bracketType: SeedBracketType): Promise<PlayoffSeed[]> {
    const result = await this.db.query(
      `SELECT ps.*, r.settings->>'team_name' as team_name, r.user_id
       FROM playoff_seeds ps
       JOIN rosters r ON ps.roster_id = r.id
       WHERE ps.bracket_id = $1 AND ps.bracket_type = $2
       ORDER BY ps.seed`,
      [bracketId, bracketType]
    );
    return result.rows.map(playoffSeedFromDatabase);
  }

  /**
   * Get seed by roster ID
   */
  async getSeedByRoster(bracketId: number, rosterId: number): Promise<PlayoffSeed | null> {
    const result = await this.db.query(
      `SELECT ps.*, r.settings->>'team_name' as team_name, r.user_id
       FROM playoff_seeds ps
       JOIN rosters r ON ps.roster_id = r.id
       WHERE ps.bracket_id = $1 AND ps.roster_id = $2`,
      [bracketId, rosterId]
    );
    if (result.rows.length === 0) return null;
    return playoffSeedFromDatabase(result.rows[0]);
  }

  /**
   * Get playoff matchups for a league/season (defaults to WINNERS bracket for backwards compatibility)
   */
  async getPlayoffMatchups(leagueId: number, season: number): Promise<any[]> {
    const result = await this.db.query(
      `SELECT m.*,
              r1.settings->>'team_name' as roster1_team_name,
              r2.settings->>'team_name' as roster2_team_name,
              r1.user_id as roster1_user_id,
              r2.user_id as roster2_user_id
       FROM matchups m
       JOIN rosters r1 ON m.roster1_id = r1.id
       JOIN rosters r2 ON m.roster2_id = r2.id
       WHERE m.league_id = $1
         AND m.season = $2
         AND m.is_playoff = true
         AND m.bracket_type = 'WINNERS'
       ORDER BY m.week, m.bracket_position`,
      [leagueId, season]
    );
    return result.rows;
  }

  /**
   * Get playoff matchups filtered by bracket type
   */
  async getPlayoffMatchupsByType(
    leagueId: number,
    season: number,
    bracketType: BracketType
  ): Promise<any[]> {
    const result = await this.db.query(
      `SELECT m.*,
              r1.settings->>'team_name' as roster1_team_name,
              r2.settings->>'team_name' as roster2_team_name,
              r1.user_id as roster1_user_id,
              r2.user_id as roster2_user_id
       FROM matchups m
       JOIN rosters r1 ON m.roster1_id = r1.id
       JOIN rosters r2 ON m.roster2_id = r2.id
       WHERE m.league_id = $1
         AND m.season = $2
         AND m.is_playoff = true
         AND m.bracket_type = $3
       ORDER BY m.week, m.bracket_position`,
      [leagueId, season, bracketType]
    );
    return result.rows;
  }

  /**
   * Create a playoff matchup (legacy - defaults to series_game=1, series_length=1)
   */
  async createPlayoffMatchup(
    leagueId: number,
    season: number,
    week: number,
    roster1Id: number,
    roster2Id: number,
    playoffRound: number,
    seed1: number,
    seed2: number,
    bracketPosition: number,
    bracketType: BracketType = 'WINNERS',
    client?: PoolClient
  ): Promise<number> {
    // Delegate to series-aware method with defaults
    return this.createPlayoffMatchupWithSeries(
      leagueId,
      season,
      week,
      roster1Id,
      roster2Id,
      playoffRound,
      seed1,
      seed2,
      bracketPosition,
      bracketType,
      null, // seriesId
      1, // seriesGame
      1, // seriesLength
      client
    );
  }

  /**
   * Create a playoff matchup with series information
   */
  async createPlayoffMatchupWithSeries(
    leagueId: number,
    season: number,
    week: number,
    roster1Id: number,
    roster2Id: number,
    playoffRound: number,
    seed1: number,
    seed2: number,
    bracketPosition: number,
    bracketType: BracketType,
    seriesId: string | null,
    seriesGame: number,
    seriesLength: number,
    client?: PoolClient
  ): Promise<number> {
    const db = client || this.db;
    const result = await db.query(
      `INSERT INTO matchups
       (league_id, season, week, roster1_id, roster2_id, is_playoff, playoff_round,
        playoff_seed1, playoff_seed2, bracket_position, bracket_type,
        series_id, series_game, series_length)
       VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (league_id, season, bracket_type, playoff_round, bracket_position, COALESCE(series_game, 1))
         WHERE is_playoff = true DO NOTHING
       RETURNING id`,
      [
        leagueId,
        season,
        week,
        roster1Id,
        roster2Id,
        playoffRound,
        seed1,
        seed2,
        bracketPosition,
        bracketType,
        seriesId,
        seriesGame,
        seriesLength,
      ]
    );
    // Return 0 if conflict (idempotent)
    return result.rows[0]?.id ?? 0;
  }

  /**
   * Get matchups for a specific playoff round
   */
  async getMatchupsByRound(leagueId: number, season: number, round: number): Promise<any[]> {
    const result = await this.db.query(
      `SELECT m.*,
              r1.settings->>'team_name' as roster1_team_name,
              r2.settings->>'team_name' as roster2_team_name
       FROM matchups m
       JOIN rosters r1 ON m.roster1_id = r1.id
       JOIN rosters r2 ON m.roster2_id = r2.id
       WHERE m.league_id = $1
         AND m.season = $2
         AND m.playoff_round = $3
       ORDER BY m.bracket_position`,
      [leagueId, season, round]
    );
    return result.rows;
  }

  /**
   * Delete playoff matchups for a league/season (for regenerating)
   */
  async deletePlayoffMatchups(
    leagueId: number,
    season: number,
    client?: PoolClient
  ): Promise<void> {
    const db = client || this.db;
    await db.query(
      'DELETE FROM matchups WHERE league_id = $1 AND season = $2 AND is_playoff = true',
      [leagueId, season]
    );
  }

  /**
   * Check if playoff matchups exist for a round (defaults to WINNERS for backwards compatibility)
   */
  async roundMatchupsExist(leagueId: number, season: number, round: number): Promise<boolean> {
    const result = await this.db.query(
      `SELECT COUNT(*) as count FROM matchups
       WHERE league_id = $1 AND season = $2 AND playoff_round = $3 AND bracket_type = 'WINNERS'`,
      [leagueId, season, round]
    );
    return (Number(result.rows[0].count) || 0) > 0;
  }

  /**
   * Check if matchups exist for a bracket type and round
   */
  async roundMatchupsExistForType(
    leagueId: number,
    season: number,
    round: number,
    bracketType: BracketType
  ): Promise<boolean> {
    const result = await this.db.query(
      `SELECT COUNT(*) as count FROM matchups
       WHERE league_id = $1 AND season = $2 AND playoff_round = $3 AND bracket_type = $4`,
      [leagueId, season, round, bracketType]
    );
    return (Number(result.rows[0].count) || 0) > 0;
  }

  /**
   * Check if any matchups in the bracket have started or are finalized.
   * Used as a guard against deleting/regenerating active playoffs.
   */
  async hasStartedMatchups(
    leagueId: number,
    season: number,
    client?: PoolClient
  ): Promise<boolean> {
    const db = client || this.db;
    const result = await db.query(
      `SELECT EXISTS (
         SELECT 1 FROM matchups
         WHERE league_id = $1 AND season = $2 AND is_playoff = true
         AND (is_final = true OR roster1_points > 0 OR roster2_points > 0)
       )`,
      [leagueId, season]
    );
    return result.rows[0].exists;
  }

  /**
   * Get finalized matchups for a playoff week (defaults to WINNERS for backwards compatibility)
   */
  async getFinalizedMatchupsForWeek(
    leagueId: number,
    season: number,
    week: number
  ): Promise<any[]> {
    const result = await this.db.query(
      `SELECT m.*,
              r1.settings->>'team_name' as roster1_team_name,
              r2.settings->>'team_name' as roster2_team_name
       FROM matchups m
       JOIN rosters r1 ON m.roster1_id = r1.id
       JOIN rosters r2 ON m.roster2_id = r2.id
       WHERE m.league_id = $1
         AND m.season = $2
         AND m.week = $3
         AND m.is_playoff = true
         AND m.is_final = true
         AND m.bracket_type = 'WINNERS'
       ORDER BY m.bracket_position`,
      [leagueId, season, week]
    );
    return result.rows;
  }

  /**
   * Get finalized matchups for a week by bracket type
   */
  async getFinalizedMatchupsForWeekByType(
    leagueId: number,
    season: number,
    week: number,
    bracketType: BracketType
  ): Promise<any[]> {
    const result = await this.db.query(
      `SELECT m.*,
              r1.settings->>'team_name' as roster1_team_name,
              r2.settings->>'team_name' as roster2_team_name
       FROM matchups m
       JOIN rosters r1 ON m.roster1_id = r1.id
       JOIN rosters r2 ON m.roster2_id = r2.id
       WHERE m.league_id = $1
         AND m.season = $2
         AND m.week = $3
         AND m.is_playoff = true
         AND m.is_final = true
         AND m.bracket_type = $4
       ORDER BY m.bracket_position`,
      [leagueId, season, week, bracketType]
    );
    return result.rows;
  }

  /**
   * Set third place winner roster ID
   */
  async setThirdPlaceWinner(
    bracketId: number,
    thirdPlaceRosterId: number,
    client?: PoolClient
  ): Promise<void> {
    const db = client || this.db;
    await db.query(
      `UPDATE playoff_brackets
       SET third_place_roster_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [thirdPlaceRosterId, bracketId]
    );
  }

  /**
   * Set consolation winner roster ID
   */
  async setConsolationWinner(
    bracketId: number,
    consolationWinnerRosterId: number,
    client?: PoolClient
  ): Promise<void> {
    const db = client || this.db;
    await db.query(
      `UPDATE playoff_brackets
       SET consolation_winner_roster_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [consolationWinnerRosterId, bracketId]
    );
  }

  // ============================================================================
  // Series-specific methods for multi-week playoff matchups
  // ============================================================================

  /**
   * Get all matchups in a series by series_id
   */
  async getSeriesMatchups(seriesId: string): Promise<any[]> {
    const result = await this.db.query(
      `SELECT m.*,
              r1.settings->>'team_name' as roster1_team_name,
              r2.settings->>'team_name' as roster2_team_name
       FROM matchups m
       JOIN rosters r1 ON m.roster1_id = r1.id
       JOIN rosters r2 ON m.roster2_id = r2.id
       WHERE m.series_id = $1
       ORDER BY m.series_game`,
      [seriesId]
    );
    return result.rows;
  }

  /**
   * Get series aggregation (total points, completion status) for determining winner
   */
  async getSeriesAggregation(seriesId: string): Promise<SeriesAggregation | null> {
    const result = await this.db.query(
      `SELECT
         series_id,
         roster1_id,
         roster2_id,
         playoff_seed1,
         playoff_seed2,
         series_length,
         SUM(COALESCE(roster1_points, 0)) as roster1_total,
         SUM(COALESCE(roster2_points, 0)) as roster2_total,
         COUNT(*) FILTER (WHERE is_final = true) as games_completed,
         COUNT(*) as total_games
       FROM matchups
       WHERE series_id = $1
       GROUP BY series_id, roster1_id, roster2_id, playoff_seed1, playoff_seed2, series_length`,
      [seriesId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      seriesId: row.series_id,
      roster1Id: row.roster1_id,
      roster2Id: row.roster2_id,
      roster1TotalPoints: parseFloat(row.roster1_total) || 0,
      roster2TotalPoints: parseFloat(row.roster2_total) || 0,
      roster1Seed: row.playoff_seed1,
      roster2Seed: row.playoff_seed2,
      gamesCompleted: Number(row.games_completed) || 0,
      seriesLength: row.series_length || 1,
      isComplete: (Number(row.games_completed) || 0) >= (row.series_length || 1),
    };
  }

  /**
   * Check if a series is complete (all games finalized)
   */
  async isSeriesComplete(seriesId: string): Promise<boolean> {
    const agg = await this.getSeriesAggregation(seriesId);
    return agg?.isComplete ?? false;
  }

  /**
   * Get all unique series for a specific round and bracket type
   */
  async getSeriesForRound(
    leagueId: number,
    season: number,
    round: number,
    bracketType: BracketType
  ): Promise<string[]> {
    const result = await this.db.query(
      `SELECT DISTINCT series_id
       FROM matchups
       WHERE league_id = $1
         AND season = $2
         AND playoff_round = $3
         AND bracket_type = $4
         AND series_id IS NOT NULL`,
      [leagueId, season, round, bracketType]
    );
    return result.rows.map((r) => r.series_id);
  }

  /**
   * Get completed series for a round (all games finalized)
   */
  async getCompletedSeriesForRound(
    leagueId: number,
    season: number,
    round: number,
    bracketType: BracketType
  ): Promise<SeriesAggregation[]> {
    const seriesIds = await this.getSeriesForRound(leagueId, season, round, bracketType);
    const completedSeries: SeriesAggregation[] = [];

    for (const seriesId of seriesIds) {
      const agg = await this.getSeriesAggregation(seriesId);
      if (agg && agg.isComplete) {
        completedSeries.push(agg);
      }
    }

    return completedSeries;
  }

  /**
   * Get the last week of a series (used to determine when advancement should happen)
   */
  async getSeriesLastWeek(seriesId: string): Promise<number | null> {
    const result = await this.db.query(
      `SELECT MAX(week) as last_week FROM matchups WHERE series_id = $1`,
      [seriesId]
    );
    return result.rows[0]?.last_week ?? null;
  }

  /**
   * Check if all series for a round are complete
   */
  async areAllSeriesCompleteForRound(
    leagueId: number,
    season: number,
    round: number,
    bracketType: BracketType
  ): Promise<boolean> {
    const result = await this.db.query(
      `SELECT
         COUNT(DISTINCT series_id) as total_series,
         COUNT(DISTINCT series_id) FILTER (
           WHERE series_id IN (
             SELECT series_id FROM matchups m2
             WHERE m2.series_id = matchups.series_id
             GROUP BY m2.series_id
             HAVING COUNT(*) FILTER (WHERE is_final = true) >= MAX(series_length)
           )
         ) as completed_series
       FROM matchups
       WHERE league_id = $1
         AND season = $2
         AND playoff_round = $3
         AND bracket_type = $4
         AND series_id IS NOT NULL`,
      [leagueId, season, round, bracketType]
    );

    const row = result.rows[0];
    const total = Number(row.total_series) || 0;
    const completed = Number(row.completed_series) || 0;
    return total > 0 && total === completed;
  }

  /**
   * Get finalized matchups for the last game of each series in a week
   * Used for advancement - only triggers when the final game of a series is finalized
   */
  async getFinalizedSeriesEndingInWeek(
    leagueId: number,
    season: number,
    week: number,
    bracketType: BracketType
  ): Promise<SeriesAggregation[]> {
    // Get all series where the last game is in this week and is finalized
    const result = await this.db.query(
      `SELECT DISTINCT m.series_id
       FROM matchups m
       WHERE m.league_id = $1
         AND m.season = $2
         AND m.week = $3
         AND m.bracket_type = $4
         AND m.is_playoff = true
         AND m.is_final = true
         AND m.series_id IS NOT NULL
         AND m.series_game = m.series_length`,
      [leagueId, season, week, bracketType]
    );

    const completedSeries: SeriesAggregation[] = [];
    for (const row of result.rows) {
      const agg = await this.getSeriesAggregation(row.series_id);
      if (agg && agg.isComplete) {
        completedSeries.push(agg);
      }
    }

    return completedSeries;
  }
}
