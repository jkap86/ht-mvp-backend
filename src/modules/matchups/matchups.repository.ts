import { Pool, PoolClient } from 'pg';
import { Matchup, MatchupDetails, Standing, matchupFromDatabase } from './matchups.model';

export class MatchupsRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Get matchup by ID
   */
  async findById(matchupId: number): Promise<Matchup | null> {
    const result = await this.db.query('SELECT * FROM matchups WHERE id = $1', [matchupId]);

    if (result.rows.length === 0) return null;
    return matchupFromDatabase(result.rows[0]);
  }

  /**
   * Get matchups for a league/week
   */
  async findByLeagueAndWeek(leagueId: number, season: number, week: number): Promise<Matchup[]> {
    const result = await this.db.query(
      `SELECT * FROM matchups
       WHERE league_id = $1 AND season = $2 AND week = $3
       ORDER BY id`,
      [leagueId, season, week]
    );

    return result.rows.map(matchupFromDatabase);
  }

  /**
   * Get matchups for a league/week with team names
   */
  async findByLeagueAndWeekWithDetails(
    leagueId: number,
    season: number,
    week: number
  ): Promise<MatchupDetails[]> {
    const result = await this.db.query(
      `SELECT m.*,
              COALESCE(r1.settings->>'team_name', u1.username, 'Team ' || r1.roster_id) as roster1_team_name,
              COALESCE(r2.settings->>'team_name', u2.username, 'Team ' || r2.roster_id) as roster2_team_name
       FROM matchups m
       JOIN rosters r1 ON m.roster1_id = r1.id
       JOIN rosters r2 ON m.roster2_id = r2.id
       LEFT JOIN users u1 ON r1.user_id = u1.id
       LEFT JOIN users u2 ON r2.user_id = u2.id
       WHERE m.league_id = $1 AND m.season = $2 AND m.week = $3
       ORDER BY m.id`,
      [leagueId, season, week]
    );

    return result.rows.map((row) => ({
      ...matchupFromDatabase(row),
      roster1TeamName: row.roster1_team_name,
      roster2TeamName: row.roster2_team_name,
      roster1Record: { wins: 0, losses: 0, ties: 0 },
      roster2Record: { wins: 0, losses: 0, ties: 0 },
    }));
  }

  /**
   * Get matchup for a specific roster/week
   */
  async findByRosterAndWeek(
    rosterId: number,
    season: number,
    week: number
  ): Promise<Matchup | null> {
    const result = await this.db.query(
      `SELECT * FROM matchups
       WHERE (roster1_id = $1 OR roster2_id = $1) AND season = $2 AND week = $3`,
      [rosterId, season, week]
    );

    if (result.rows.length === 0) return null;
    return matchupFromDatabase(result.rows[0]);
  }

  /**
   * Create a matchup
   */
  async create(
    leagueId: number,
    season: number,
    week: number,
    roster1Id: number,
    roster2Id: number,
    isPlayoff: boolean = false,
    client?: PoolClient
  ): Promise<Matchup> {
    const db = client || this.db;
    const result = await db.query(
      `INSERT INTO matchups (league_id, season, week, roster1_id, roster2_id, is_playoff)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [leagueId, season, week, roster1Id, roster2Id, isPlayoff]
    );

    return matchupFromDatabase(result.rows[0]);
  }

  /**
   * Update matchup points
   */
  async updatePoints(
    matchupId: number,
    roster1Points: number,
    roster2Points: number,
    client?: PoolClient
  ): Promise<Matchup> {
    const db = client || this.db;
    const result = await db.query(
      `UPDATE matchups
       SET roster1_points = $2, roster2_points = $3
       WHERE id = $1
       RETURNING *`,
      [matchupId, roster1Points, roster2Points]
    );

    return matchupFromDatabase(result.rows[0]);
  }

  /**
   * Finalize a matchup
   */
  async finalize(matchupId: number, client?: PoolClient): Promise<Matchup> {
    const db = client || this.db;
    const result = await db.query(
      `UPDATE matchups
       SET is_final = true
       WHERE id = $1
       RETURNING *`,
      [matchupId]
    );

    return matchupFromDatabase(result.rows[0]);
  }

  /**
   * Get all finalized matchups for a roster in a season
   */
  async getFinalizedByRoster(rosterId: number, season: number): Promise<Matchup[]> {
    const result = await this.db.query(
      `SELECT * FROM matchups
       WHERE (roster1_id = $1 OR roster2_id = $1)
         AND season = $2
         AND is_final = true
       ORDER BY week`,
      [rosterId, season]
    );

    return result.rows.map(matchupFromDatabase);
  }

  /**
   * Get all finalized matchups for a league in a season
   */
  async getFinalizedByLeague(leagueId: number, season: number): Promise<Matchup[]> {
    const result = await this.db.query(
      `SELECT * FROM matchups
       WHERE league_id = $1
         AND season = $2
         AND is_final = true
       ORDER BY week`,
      [leagueId, season]
    );

    return result.rows.map(matchupFromDatabase);
  }

  /**
   * Calculate standings from finalized matchups
   */
  async getStandings(leagueId: number, season: number): Promise<Standing[]> {
    const result = await this.db.query(
      `WITH roster_results AS (
        SELECT
          r.id as roster_id,
          COALESCE(r.settings->>'team_name', u.username, 'Team ' || r.roster_id) as team_name,
          r.user_id,
          COALESCE(SUM(CASE
            WHEN m.roster1_id = r.id AND m.roster1_points > m.roster2_points THEN 1
            WHEN m.roster2_id = r.id AND m.roster2_points > m.roster1_points THEN 1
            ELSE 0
          END), 0) as wins,
          COALESCE(SUM(CASE
            WHEN m.roster1_id = r.id AND m.roster1_points < m.roster2_points THEN 1
            WHEN m.roster2_id = r.id AND m.roster2_points < m.roster1_points THEN 1
            ELSE 0
          END), 0) as losses,
          COALESCE(SUM(CASE
            WHEN m.roster1_points = m.roster2_points AND m.is_final THEN 1
            ELSE 0
          END), 0) as ties,
          COALESCE(SUM(CASE
            WHEN m.roster1_id = r.id THEN m.roster1_points
            WHEN m.roster2_id = r.id THEN m.roster2_points
            ELSE 0
          END), 0) as points_for,
          COALESCE(SUM(CASE
            WHEN m.roster1_id = r.id THEN m.roster2_points
            WHEN m.roster2_id = r.id THEN m.roster1_points
            ELSE 0
          END), 0) as points_against
        FROM rosters r
        LEFT JOIN users u ON r.user_id = u.id
        LEFT JOIN matchups m ON (m.roster1_id = r.id OR m.roster2_id = r.id)
          AND m.season = $2
          AND m.is_final = true
        WHERE r.league_id = $1
        GROUP BY r.id, r.settings, u.username
      )
      SELECT
        roster_id,
        team_name,
        user_id,
        wins,
        losses,
        ties,
        points_for,
        points_against,
        ROW_NUMBER() OVER (ORDER BY wins DESC, points_for DESC) as rank
      FROM roster_results
      ORDER BY wins DESC, points_for DESC`,
      [leagueId, season]
    );

    // Helper to round to 2 decimal places
    const roundPoints = (pts: number) => Math.round(pts * 100) / 100;

    return result.rows.map((row) => ({
      rosterId: row.roster_id,
      teamName: row.team_name,
      userId: row.user_id,
      wins: parseInt(row.wins, 10),
      losses: parseInt(row.losses, 10),
      ties: parseInt(row.ties, 10),
      pointsFor: roundPoints(parseFloat(row.points_for) || 0),
      pointsAgainst: roundPoints(parseFloat(row.points_against) || 0),
      streak: '', // Would need to calculate from recent matchups
      rank: parseInt(row.rank, 10),
    }));
  }

  /**
   * Count regular season matchups for a league/season
   */
  async countByLeagueSeason(leagueId: number, season: number): Promise<number> {
    const result = await this.db.query(
      'SELECT COUNT(*) as count FROM matchups WHERE league_id = $1 AND season = $2 AND is_playoff = false',
      [leagueId, season]
    );
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Delete all matchups for a league (for regenerating schedule)
   */
  async deleteByLeague(leagueId: number, season: number): Promise<void> {
    await this.db.query('DELETE FROM matchups WHERE league_id = $1 AND season = $2', [
      leagueId,
      season,
    ]);
  }

  /**
   * Get all league IDs with non-finalized matchups for a given week
   * Used by stats sync to notify relevant leagues
   */
  async getLeaguesWithActiveMatchups(season: number, week: number): Promise<number[]> {
    const result = await this.db.query(
      `SELECT DISTINCT league_id FROM matchups
       WHERE season = $1 AND week = $2 AND is_final = false`,
      [season, week]
    );

    return result.rows.map((row) => row.league_id);
  }
}
