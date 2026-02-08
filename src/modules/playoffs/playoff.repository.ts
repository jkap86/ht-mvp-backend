import { Pool, PoolClient } from 'pg';
import {
  PlayoffBracket,
  PlayoffSeed,
  playoffBracketFromDatabase,
  playoffSeedFromDatabase,
  PlayoffStatus,
  BracketType,
  ConsolationType,
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
    client?: PoolClient
  ): Promise<PlayoffBracket> {
    const db = client || this.db;
    const result = await db.query(
      `INSERT INTO playoff_brackets
       (league_id, season, playoff_teams, total_rounds, start_week, championship_week, status,
        enable_third_place, consolation_type, consolation_teams)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9)
       RETURNING *`,
      [leagueId, season, playoffTeams, totalRounds, startWeek, championshipWeek,
       enableThirdPlace, consolationType, consolationTeams]
    );
    return playoffBracketFromDatabase(result.rows[0]);
  }

  /**
   * Find bracket by league and season
   */
  async findByLeagueSeason(leagueId: number, season: number): Promise<PlayoffBracket | null> {
    const result = await this.db.query(
      'SELECT * FROM playoff_brackets WHERE league_id = $1 AND season = $2',
      [leagueId, season]
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
   * Set champion roster ID
   */
  async setChampion(
    bracketId: number,
    championRosterId: number,
    client?: PoolClient
  ): Promise<void> {
    const db = client || this.db;
    await db.query(
      `UPDATE playoff_brackets
       SET champion_roster_id = $1, status = 'completed', updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [championRosterId, bracketId]
    );
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
    }>,
    client?: PoolClient
  ): Promise<PlayoffSeed[]> {
    const db = client || this.db;
    const createdSeeds: PlayoffSeed[] = [];

    for (const seed of seeds) {
      const result = await db.query(
        `INSERT INTO playoff_seeds
         (bracket_id, roster_id, seed, regular_season_record, points_for, has_bye)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [bracketId, seed.rosterId, seed.seed, seed.regularSeasonRecord, seed.pointsFor, seed.hasBye]
      );
      createdSeeds.push(playoffSeedFromDatabase(result.rows[0]));
    }

    return createdSeeds;
  }

  /**
   * Get seeds for a bracket with team info
   */
  async getSeeds(bracketId: number): Promise<PlayoffSeed[]> {
    const result = await this.db.query(
      `SELECT ps.*, r.settings->>'team_name' as team_name, r.user_id
       FROM playoff_seeds ps
       JOIN rosters r ON ps.roster_id = r.id
       WHERE ps.bracket_id = $1
       ORDER BY ps.seed`,
      [bracketId]
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
   * Create a playoff matchup
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
    const db = client || this.db;
    const result = await db.query(
      `INSERT INTO matchups
       (league_id, season, week, roster1_id, roster2_id, is_playoff, playoff_round, playoff_seed1, playoff_seed2, bracket_position, bracket_type)
       VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, $9, $10)
       ON CONFLICT (league_id, season, bracket_type, playoff_round, bracket_position)
         WHERE is_playoff = true DO NOTHING
       RETURNING id`,
      [leagueId, season, week, roster1Id, roster2Id, playoffRound, seed1, seed2, bracketPosition, bracketType]
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
    return parseInt(result.rows[0].count, 10) > 0;
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
    return parseInt(result.rows[0].count, 10) > 0;
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
}
