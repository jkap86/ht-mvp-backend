import { Pool, PoolClient } from 'pg';
import {
  WaiverPriority,
  WaiverPriorityWithDetails,
  waiverPriorityFromDatabase,
} from './waivers.model';

/**
 * Repository for waiver priority management
 */
export class WaiverPriorityRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Initialize priorities for all rosters in a league (called at season start)
   */
  async initializeForLeague(
    leagueId: number,
    season: number,
    rosterIds: number[],
    client?: PoolClient
  ): Promise<void> {
    const conn = client || this.db;

    // Delete existing priorities for this league/season
    await conn.query('DELETE FROM waiver_priority WHERE league_id = $1 AND season = $2', [
      leagueId,
      season,
    ]);

    // Insert new priorities (order by roster creation for initial)
    for (let i = 0; i < rosterIds.length; i++) {
      await conn.query(
        `INSERT INTO waiver_priority (league_id, roster_id, season, priority)
         VALUES ($1, $2, $3, $4)`,
        [leagueId, rosterIds[i], season, i + 1]
      );
    }
  }

  /**
   * Get priority list for a league/season with team details
   */
  async getByLeague(leagueId: number, season: number): Promise<WaiverPriorityWithDetails[]> {
    const result = await this.db.query(
      `SELECT wp.*,
        r.settings->>'team_name' as team_name,
        u.username as username
      FROM waiver_priority wp
      JOIN rosters r ON r.id = wp.roster_id
      JOIN users u ON u.id = r.user_id
      WHERE wp.league_id = $1 AND wp.season = $2
      ORDER BY wp.priority ASC`,
      [leagueId, season]
    );

    return result.rows.map((row) => ({
      ...waiverPriorityFromDatabase(row),
      teamName: row.team_name || `Team ${row.roster_id}`,
      username: row.username || 'Unknown',
    }));
  }

  /**
   * Get single roster's priority
   */
  async getByRoster(
    rosterId: number,
    season: number,
    client?: PoolClient
  ): Promise<WaiverPriority | null> {
    const conn = client || this.db;
    const result = await conn.query(
      'SELECT * FROM waiver_priority WHERE roster_id = $1 AND season = $2',
      [rosterId, season]
    );
    return result.rows.length > 0 ? waiverPriorityFromDatabase(result.rows[0]) : null;
  }

  /**
   * Get the maximum priority value across all rosters in a league/season.
   */
  async getMaxPriority(leagueId: number, season: number, client?: PoolClient): Promise<number> {
    const conn = client || this.db;
    const result = await conn.query(
      'SELECT COALESCE(MAX(priority), 0) as max_priority FROM waiver_priority WHERE league_id = $1 AND season = $2',
      [leagueId, season]
    );
    return Number(result.rows[0].max_priority) || 0;
  }

  /**
   * Rotate priorities - move successful claimer to last place
   * Uses a single atomic statement to avoid UNIQUE constraint violations
   */
  async rotatePriority(
    leagueId: number,
    season: number,
    claimerRosterId: number,
    client?: PoolClient
  ): Promise<void> {
    const conn = client || this.db;

    // Use a single atomic UPDATE with CASE to avoid UNIQUE constraint violations
    // This updates all priorities in one statement:
    // - The claimer moves to max priority
    // - Everyone with priority > claimer's priority shifts down by 1
    await conn.query(
      `WITH claimer_info AS (
        SELECT priority as claimer_priority,
               (SELECT MAX(priority) FROM waiver_priority WHERE league_id = $1 AND season = $2) as max_priority
        FROM waiver_priority
        WHERE league_id = $1 AND season = $2 AND roster_id = $3
      )
      UPDATE waiver_priority wp
      SET priority = CASE
        WHEN wp.roster_id = $3 THEN ci.max_priority
        WHEN wp.priority > ci.claimer_priority THEN wp.priority - 1
        ELSE wp.priority
      END
      FROM claimer_info ci
      WHERE wp.league_id = $1 AND wp.season = $2`,
      [leagueId, season, claimerRosterId]
    );
  }

  /**
   * Ensure a roster has a priority row (for late-joining rosters)
   * Assigns last place priority. Idempotent - safe to call multiple times.
   */
  async ensureRosterPriority(
    leagueId: number,
    rosterId: number,
    season: number,
    client?: PoolClient
  ): Promise<void> {
    const conn = client || this.db;

    // Get max priority for league/season, defaulting to 0 if none exist
    const maxResult = await conn.query(
      'SELECT COALESCE(MAX(priority), 0) as max_priority FROM waiver_priority WHERE league_id = $1 AND season = $2',
      [leagueId, season]
    );
    const maxPriority = Number(maxResult.rows[0].max_priority) || 0;

    // Insert with ON CONFLICT DO NOTHING for idempotency
    await conn.query(
      `INSERT INTO waiver_priority (league_id, roster_id, season, priority)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (league_id, season, roster_id) DO NOTHING`,
      [leagueId, rosterId, season, maxPriority + 1]
    );
  }
}
