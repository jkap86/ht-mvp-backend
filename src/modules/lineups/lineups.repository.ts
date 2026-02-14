import { Pool, PoolClient } from 'pg';
import { RosterLineup, LineupSlots, rosterLineupFromDatabase } from './lineups.model';
import { runInTransaction } from '../../shared/transaction-runner';

export class LineupsRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Get lineup for a roster/week
   */
  async findByRosterAndWeek(
    rosterId: number,
    season: number,
    week: number,
    client?: PoolClient
  ): Promise<RosterLineup | null> {
    const db = client || this.db;
    const result = await db.query(
      `SELECT * FROM roster_lineups
       WHERE roster_id = $1 AND season = $2 AND week = $3`,
      [rosterId, season, week]
    );

    if (result.rows.length === 0) return null;
    return rosterLineupFromDatabase(result.rows[0]);
  }

  /**
   * Create or update lineup for a roster/week
   */
  async upsert(
    rosterId: number,
    season: number,
    week: number,
    lineup: LineupSlots,
    client?: PoolClient
  ): Promise<RosterLineup> {
    const db = client || this.db;
    const result = await db.query(
      `INSERT INTO roster_lineups (roster_id, season, week, lineup)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (roster_id, season, week)
       DO UPDATE SET lineup = $4, updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [rosterId, season, week, JSON.stringify(lineup)]
    );

    return rosterLineupFromDatabase(result.rows[0]);
  }

  /**
   * Update total points for a lineup
   */
  async updatePoints(
    rosterId: number,
    season: number,
    week: number,
    totalPoints: number,
    client?: PoolClient
  ): Promise<void> {
    const db = client || this.db;
    await db.query(
      `UPDATE roster_lineups
       SET total_points = $4, updated_at = CURRENT_TIMESTAMP
       WHERE roster_id = $1 AND season = $2 AND week = $3`,
      [rosterId, season, week, totalPoints]
    );
  }

  /**
   * Update live scoring totals for a lineup (used during live games)
   * Does not affect the final total_points which is set during finalization
   */
  async updateLivePoints(
    rosterId: number,
    season: number,
    week: number,
    liveActual: number | null,
    liveProjected: number | null,
    client?: PoolClient
  ): Promise<void> {
    const db = client || this.db;
    await db.query(
      `UPDATE roster_lineups
       SET total_points_live = $4,
           total_points_projected_live = $5,
           updated_at = CURRENT_TIMESTAMP
       WHERE roster_id = $1 AND season = $2 AND week = $3`,
      [rosterId, season, week, liveActual, liveProjected]
    );
  }

  /**
   * Batch update live scoring totals for multiple lineups
   */
  async batchUpdateLivePoints(
    updates: Array<{
      rosterId: number;
      season: number;
      week: number;
      liveActual: number;
      liveProjected: number;
    }>,
    client?: PoolClient
  ): Promise<void> {
    if (updates.length === 0) return;

    const db = client || this.db;

    // Use a single query with UNNEST for better performance
    const rosterIds = updates.map((u) => u.rosterId);
    const seasons = updates.map((u) => u.season);
    const weeks = updates.map((u) => u.week);
    const liveActuals = updates.map((u) => u.liveActual);
    const liveProjecteds = updates.map((u) => u.liveProjected);

    await db.query(
      `UPDATE roster_lineups rl
       SET total_points_live = u.live_actual,
           total_points_projected_live = u.live_projected,
           updated_at = CURRENT_TIMESTAMP
       FROM (
         SELECT
           UNNEST($1::int[]) as roster_id,
           UNNEST($2::int[]) as season,
           UNNEST($3::int[]) as week,
           UNNEST($4::numeric[]) as live_actual,
           UNNEST($5::numeric[]) as live_projected
       ) u
       WHERE rl.roster_id = u.roster_id
         AND rl.season = u.season
         AND rl.week = u.week`,
      [rosterIds, seasons, weeks, liveActuals, liveProjecteds]
    );
  }

  /**
   * Lock lineups for a league/week
   */
  async lockLineups(leagueId: number, season: number, week: number): Promise<void> {
    await this.db.query(
      `UPDATE roster_lineups rl
       SET is_locked = true, updated_at = CURRENT_TIMESTAMP
       FROM rosters r
       WHERE rl.roster_id = r.id
         AND r.league_id = $1
         AND rl.season = $2
         AND rl.week = $3`,
      [leagueId, season, week]
    );
  }

  /**
   * Get all lineups for a league/week
   */
  async getByLeagueAndWeek(
    leagueId: number,
    season: number,
    week: number,
    client?: PoolClient
  ): Promise<RosterLineup[]> {
    const db = client || this.db;
    const result = await db.query(
      `SELECT rl.*
       FROM roster_lineups rl
       JOIN rosters r ON rl.roster_id = r.id
       WHERE r.league_id = $1 AND rl.season = $2 AND rl.week = $3`,
      [leagueId, season, week]
    );

    return result.rows.map(rosterLineupFromDatabase);
  }

  /**
   * Check if lineup is locked
   */
  async isLocked(rosterId: number, season: number, week: number): Promise<boolean> {
    const result = await this.db.query(
      `SELECT is_locked FROM roster_lineups
       WHERE roster_id = $1 AND season = $2 AND week = $3`,
      [rosterId, season, week]
    );

    if (result.rows.length === 0) return false;
    return result.rows[0].is_locked;
  }

  /**
   * Lock all lineups for a specific week across all leagues with a given lock time setting
   * Returns the number of lineups locked
   */
  async lockLineupsForWeekByLockTime(
    season: number,
    week: number,
    lockTimeSetting: string
  ): Promise<number> {
    const result = await this.db.query(
      `UPDATE roster_lineups rl
       SET is_locked = true, updated_at = CURRENT_TIMESTAMP
       FROM rosters r
       INNER JOIN leagues l ON r.league_id = l.id
       WHERE rl.roster_id = r.id
         AND rl.season = $1
         AND rl.week = $2
         AND l.lineup_lock_time = $3
         AND rl.is_locked = false`,
      [season, week, lockTimeSetting]
    );

    return result.rowCount || 0;
  }

  /**
   * Upsert a bestball-generated lineup
   */
  async upsertBestball(
    rosterId: number,
    season: number,
    week: number,
    lineup: LineupSlots,
    client?: PoolClient
  ): Promise<RosterLineup> {
    const db = client || this.db;
    const result = await db.query(
      `INSERT INTO roster_lineups (roster_id, season, week, lineup, is_bestball, bestball_generated_at)
       VALUES ($1, $2, $3, $4, true, CURRENT_TIMESTAMP)
       ON CONFLICT (roster_id, season, week)
       DO UPDATE SET
         lineup = $4,
         is_bestball = true,
         bestball_generated_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [rosterId, season, week, JSON.stringify(lineup)]
    );

    return rosterLineupFromDatabase(result.rows[0]);
  }

  /**
   * Batch upsert bestball-generated lineups
   */
  async batchUpsertBestball(
    updates: Array<{ rosterId: number; lineup: LineupSlots }>,
    season: number,
    week: number,
    client?: PoolClient
  ): Promise<void> {
    if (updates.length === 0) return;

    // If a client is provided, use it directly (caller manages transaction)
    if (client) {
      for (const { rosterId, lineup } of updates) {
        await client.query(
          `INSERT INTO roster_lineups (roster_id, season, week, lineup, is_bestball, bestball_generated_at)
           VALUES ($1, $2, $3, $4, true, CURRENT_TIMESTAMP)
           ON CONFLICT (roster_id, season, week)
           DO UPDATE SET
             lineup = $4,
             is_bestball = true,
             bestball_generated_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP`,
          [rosterId, season, week, JSON.stringify(lineup)]
        );
      }
      return;
    }

    // Otherwise, use transaction runner for reliable batch upserts
    await runInTransaction(this.db, async (txClient) => {
      for (const { rosterId, lineup } of updates) {
        await txClient.query(
          `INSERT INTO roster_lineups (roster_id, season, week, lineup, is_bestball, bestball_generated_at)
           VALUES ($1, $2, $3, $4, true, CURRENT_TIMESTAMP)
           ON CONFLICT (roster_id, season, week)
           DO UPDATE SET
             lineup = $4,
             is_bestball = true,
             bestball_generated_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP`,
          [rosterId, season, week, JSON.stringify(lineup)]
        );
      }
    });
  }
}
