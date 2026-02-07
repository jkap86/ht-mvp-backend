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
   * Get all matchups for a league/season (no week filter)
   * Used for finding max scheduled week
   */
  async findAllByLeagueAndSeason(leagueId: number, season: number): Promise<Matchup[]> {
    const result = await this.db.query(
      `SELECT * FROM matchups
       WHERE league_id = $1 AND season = $2
       ORDER BY week, id`,
      [leagueId, season]
    );

    return result.rows.map(matchupFromDatabase);
  }

  /**
   * Get all matchups for a league/season with team names
   */
  async findAllByLeagueAndSeasonWithDetails(leagueId: number, season: number): Promise<MatchupDetails[]> {
    const result = await this.db.query(
      `SELECT m.*,
              COALESCE(r1.settings->>'team_name', u1.username, 'Team ' || r1.roster_id) as roster1_team_name,
              COALESCE(r2.settings->>'team_name', u2.username, 'Team ' || r2.roster_id) as roster2_team_name
       FROM matchups m
       JOIN rosters r1 ON m.roster1_id = r1.id
       JOIN rosters r2 ON m.roster2_id = r2.id
       LEFT JOIN users u1 ON r1.user_id = u1.id
       LEFT JOIN users u2 ON r2.user_id = u2.id
       WHERE m.league_id = $1 AND m.season = $2
       ORDER BY m.week, m.id`,
      [leagueId, season]
    );

    return result.rows.map((row) => ({
      ...matchupFromDatabase(row),
      roster1TeamName: row.roster1_team_name,
      roster2TeamName: row.roster2_team_name,
    }));
  }

  /**
   * Get the maximum week number with scheduled matchups for a league/season
   */
  async getMaxScheduledWeek(leagueId: number, season: number): Promise<number | null> {
    const result = await this.db.query(
      `SELECT MAX(week) as max_week FROM matchups WHERE league_id = $1 AND season = $2`,
      [leagueId, season]
    );

    return result.rows[0]?.max_week ?? null;
  }

  /**
   * Get matchups for a league/week with team names and live scores
   */
  async findByLeagueAndWeekWithDetails(
    leagueId: number,
    season: number,
    week: number
  ): Promise<MatchupDetails[]> {
    const result = await this.db.query(
      `SELECT m.*,
              COALESCE(r1.settings->>'team_name', u1.username, 'Team ' || r1.roster_id) as roster1_team_name,
              COALESCE(r2.settings->>'team_name', u2.username, 'Team ' || r2.roster_id) as roster2_team_name,
              rl1.total_points_live as roster1_points_live,
              rl1.total_points_projected_live as roster1_points_projected,
              rl2.total_points_live as roster2_points_live,
              rl2.total_points_projected_live as roster2_points_projected
       FROM matchups m
       JOIN rosters r1 ON m.roster1_id = r1.id
       JOIN rosters r2 ON m.roster2_id = r2.id
       LEFT JOIN users u1 ON r1.user_id = u1.id
       LEFT JOIN users u2 ON r2.user_id = u2.id
       LEFT JOIN roster_lineups rl1 ON m.roster1_id = rl1.roster_id
         AND rl1.season = m.season AND rl1.week = m.week
       LEFT JOIN roster_lineups rl2 ON m.roster2_id = rl2.roster_id
         AND rl2.season = m.season AND rl2.week = m.week
       WHERE m.league_id = $1 AND m.season = $2 AND m.week = $3
       ORDER BY m.id`,
      [leagueId, season, week]
    );

    return result.rows.map((row) => ({
      ...matchupFromDatabase(row),
      roster1TeamName: row.roster1_team_name,
      roster2TeamName: row.roster2_team_name,
      // Live scores (for non-final matchups)
      roster1PointsActual: row.roster1_points_live ? parseFloat(row.roster1_points_live) : null,
      roster1PointsProjected: row.roster1_points_projected
        ? parseFloat(row.roster1_points_projected)
        : null,
      roster2PointsActual: row.roster2_points_live ? parseFloat(row.roster2_points_live) : null,
      roster2PointsProjected: row.roster2_points_projected
        ? parseFloat(row.roster2_points_projected)
        : null,
    }));
  }

  /**
   * Get a single matchup by ID with team names and live scores (efficient single-matchup fetch)
   */
  async findByIdWithDetails(matchupId: number): Promise<MatchupDetails | null> {
    const result = await this.db.query(
      `SELECT m.*,
              COALESCE(r1.settings->>'team_name', u1.username, 'Team ' || r1.roster_id) as roster1_team_name,
              COALESCE(r2.settings->>'team_name', u2.username, 'Team ' || r2.roster_id) as roster2_team_name,
              rl1.total_points_live as roster1_points_live,
              rl1.total_points_projected_live as roster1_points_projected,
              rl2.total_points_live as roster2_points_live,
              rl2.total_points_projected_live as roster2_points_projected
       FROM matchups m
       JOIN rosters r1 ON m.roster1_id = r1.id
       JOIN rosters r2 ON m.roster2_id = r2.id
       LEFT JOIN users u1 ON r1.user_id = u1.id
       LEFT JOIN users u2 ON r2.user_id = u2.id
       LEFT JOIN roster_lineups rl1 ON m.roster1_id = rl1.roster_id
         AND rl1.season = m.season AND rl1.week = m.week
       LEFT JOIN roster_lineups rl2 ON m.roster2_id = rl2.roster_id
         AND rl2.season = m.season AND rl2.week = m.week
       WHERE m.id = $1`,
      [matchupId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      ...matchupFromDatabase(row),
      roster1TeamName: row.roster1_team_name,
      roster2TeamName: row.roster2_team_name,
      // Live scores (for non-final matchups)
      roster1PointsActual: row.roster1_points_live ? parseFloat(row.roster1_points_live) : null,
      roster1PointsProjected: row.roster1_points_projected
        ? parseFloat(row.roster1_points_projected)
        : null,
      roster2PointsActual: row.roster2_points_live ? parseFloat(row.roster2_points_live) : null,
      roster2PointsProjected: row.roster2_points_projected
        ? parseFloat(row.roster2_points_projected)
        : null,
    };
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
   * Calculate standings from finalized matchups.
   * Includes H2H and median record breakdown when median data exists.
   * Totals are gated by the useLeagueMedian setting - when OFF, only H2H counts.
   */
  async getStandings(leagueId: number, season: number): Promise<Standing[]> {
    const result = await this.db.query(
      `WITH league_cfg AS (
        SELECT (COALESCE(league_settings->>'useLeagueMedian', 'false'))::boolean AS use_median
        FROM leagues
        WHERE id = $1
      ),
      h2h_results AS (
        SELECT
          r.id as roster_id,
          COALESCE(r.settings->>'team_name', u.username, 'Team ' || r.roster_id) as team_name,
          r.user_id,
          COALESCE(SUM(CASE
            WHEN m.roster1_id = r.id AND m.roster1_points > m.roster2_points THEN 1
            WHEN m.roster2_id = r.id AND m.roster2_points > m.roster1_points THEN 1
            ELSE 0
          END), 0) as h2h_wins,
          COALESCE(SUM(CASE
            WHEN m.roster1_id = r.id AND m.roster1_points < m.roster2_points THEN 1
            WHEN m.roster2_id = r.id AND m.roster2_points < m.roster1_points THEN 1
            ELSE 0
          END), 0) as h2h_losses,
          COALESCE(SUM(CASE
            WHEN m.roster1_points = m.roster2_points AND m.is_final THEN 1
            ELSE 0
          END), 0) as h2h_ties,
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
      ),
      median_agg AS (
        SELECT
          wmr.roster_id,
          SUM(CASE WHEN wmr.result = 'W' THEN 1 ELSE 0 END) as median_wins,
          SUM(CASE WHEN wmr.result = 'L' THEN 1 ELSE 0 END) as median_losses,
          SUM(CASE WHEN wmr.result = 'T' THEN 1 ELSE 0 END) as median_ties
        FROM weekly_median_results wmr
        WHERE wmr.league_id = $1 AND wmr.season = $2
          -- Only count median for regular season weeks (safety check)
          AND EXISTS (
            SELECT 1 FROM matchups m
            WHERE m.league_id = wmr.league_id
              AND m.season = wmr.season
              AND m.week = wmr.week
              AND m.is_playoff = false
            LIMIT 1
          )
        GROUP BY wmr.roster_id
      )
      SELECT
        h.roster_id,
        h.team_name,
        h.user_id,
        h.h2h_wins,
        h.h2h_losses,
        h.h2h_ties,
        m.median_wins,
        m.median_losses,
        m.median_ties,
        -- Totals gated by setting: when OFF, only H2H counts
        CASE WHEN (SELECT use_median FROM league_cfg)
          THEN h.h2h_wins + COALESCE(m.median_wins, 0)
          ELSE h.h2h_wins
        END as total_wins,
        CASE WHEN (SELECT use_median FROM league_cfg)
          THEN h.h2h_losses + COALESCE(m.median_losses, 0)
          ELSE h.h2h_losses
        END as total_losses,
        CASE WHEN (SELECT use_median FROM league_cfg)
          THEN h.h2h_ties + COALESCE(m.median_ties, 0)
          ELSE h.h2h_ties
        END as total_ties,
        h.points_for,
        h.points_against,
        ROW_NUMBER() OVER (ORDER BY
          CASE WHEN (SELECT use_median FROM league_cfg)
            THEN h.h2h_wins + COALESCE(m.median_wins, 0)
            ELSE h.h2h_wins
          END DESC,
          h.points_for DESC
        ) as rank
      FROM h2h_results h
      LEFT JOIN median_agg m ON h.roster_id = m.roster_id
      ORDER BY rank`,
      [leagueId, season]
    );

    // Helper to round to 2 decimal places
    const roundPoints = (pts: number) => Math.round(pts * 100) / 100;

    return result.rows.map((row) => ({
      rosterId: row.roster_id,
      teamName: row.team_name,
      userId: row.user_id,
      // Total record (H2H + Median)
      wins: parseInt(row.total_wins, 10),
      losses: parseInt(row.total_losses, 10),
      ties: parseInt(row.total_ties, 10),
      // H2H breakdown
      h2hWins: parseInt(row.h2h_wins, 10),
      h2hLosses: parseInt(row.h2h_losses, 10),
      h2hTies: parseInt(row.h2h_ties, 10),
      // Median breakdown (null if no median data exists)
      medianWins: row.median_wins != null ? parseInt(row.median_wins, 10) : null,
      medianLosses: row.median_losses != null ? parseInt(row.median_losses, 10) : null,
      medianTies: row.median_ties != null ? parseInt(row.median_ties, 10) : null,
      // Other stats
      pointsFor: roundPoints(parseFloat(row.points_for) || 0),
      pointsAgainst: roundPoints(parseFloat(row.points_against) || 0),
      streak: '', // Calculated separately in StandingsService
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

  /**
   * Check if a league has any finalized matchups for a season.
   * Used to enforce toggle lock for league median setting.
   */
  async hasAnyFinalizedMatchups(leagueId: number, season: number): Promise<boolean> {
    const result = await this.db.query(
      `SELECT EXISTS(
        SELECT 1 FROM matchups
        WHERE league_id = $1 AND season = $2 AND is_final = true
      ) as has_finalized`,
      [leagueId, season]
    );

    return result.rows[0].has_finalized;
  }
}
