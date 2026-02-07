import { Pool, PoolClient } from 'pg';
import { LineupsRepository } from '../lineups/lineups.repository';
import { LeagueRepository } from '../leagues/leagues.repository';
import { MatchupsRepository } from './matchups.repository';
import { ForbiddenException, ValidationException } from '../../utils/exceptions';

export interface MedianResult {
  rosterId: number;
  points: number;
  result: 'W' | 'L' | 'T';
}

export interface WeeklyMedianData {
  leagueId: number;
  season: number;
  week: number;
  medianPoints: number;
  results: MedianResult[];
}

/**
 * Service for calculating and storing league median results.
 * When enabled, each team earns an additional W/L/T each week based on
 * whether their score is above/below/equal to the league median.
 */
export class MedianService {
  constructor(
    private readonly db: Pool,
    private readonly lineupsRepo: LineupsRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly matchupsRepo: MatchupsRepository
  ) {}

  /**
   * Calculate the median of an array of numbers.
   * - Even count: average of two middle values
   * - Odd count: middle value exactly
   */
  private calculateMedian(values: number[]): number {
    if (values.length === 0) return 0;

    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
      // Even: average of two middle values
      return (sorted[mid - 1] + sorted[mid]) / 2;
    } else {
      // Odd: middle value exactly
      return sorted[mid];
    }
  }

  /**
   * Compare a score to the median and return the result.
   */
  private getMedianResult(score: number, median: number): 'W' | 'L' | 'T' {
    if (score > median) return 'W';
    if (score < median) return 'L';
    return 'T';
  }

  /**
   * Calculate and store median results for a week.
   * Should be called within a transaction during week finalization.
   *
   * Important: Includes ALL rosters, even those without a lineup row.
   * Rosters without a lineup get 0 points to ensure they're included in the median
   * calculation and receive a median result.
   *
   * @param client - Database client (must be within a transaction)
   * @param leagueId - League ID
   * @param season - Season year
   * @param week - Week number
   * @returns The calculated median points, or null if skipped
   */
  async calculateAndStoreMedianResults(
    client: PoolClient,
    leagueId: number,
    season: number,
    week: number
  ): Promise<number | null> {
    // Get ALL rosters with their lineup points (0 if no lineup row exists)
    // This ensures rosters without lineups are included in median calculation
    const result = await client.query(
      `SELECT r.id AS roster_id,
              COALESCE(rl.total_points, 0) AS points
       FROM rosters r
       LEFT JOIN roster_lineups rl
         ON rl.roster_id = r.id
        AND rl.season = $2
        AND rl.week = $3
       WHERE r.league_id = $1`,
      [leagueId, season, week]
    );

    const scores = result.rows.map((row) => ({
      rosterId: Number(row.roster_id),
      points: Number(row.points) || 0,
    }));

    // Skip if insufficient teams (need at least 2 for meaningful median)
    if (scores.length < 2) {
      return null;
    }

    // Calculate median
    const allPoints = scores.map((s) => s.points);
    const median = this.calculateMedian(allPoints);

    // Round median to 2 decimal places for storage
    const roundedMedian = Math.round(median * 100) / 100;

    // Delete existing results for idempotency
    await client.query(
      'DELETE FROM weekly_median_results WHERE league_id = $1 AND season = $2 AND week = $3',
      [leagueId, season, week]
    );

    // Insert new results for each roster
    for (const { rosterId, points } of scores) {
      const medianResult = this.getMedianResult(points, median);
      await client.query(
        `INSERT INTO weekly_median_results
         (league_id, season, week, median_points, roster_id, roster_points, result)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [leagueId, season, week, roundedMedian, rosterId, points, medianResult]
      );
    }

    return roundedMedian;
  }

  /**
   * Recalculate median results for a specific week.
   * Used by commissioners to fix data after score corrections.
   *
   * @param leagueId - League ID
   * @param season - Season year
   * @param week - Week to recalculate
   * @param userId - User ID (must be commissioner)
   * @returns The new median points
   */
  async recalculateWeekMedian(
    leagueId: number,
    season: number,
    week: number,
    userId: string
  ): Promise<{ medianPoints: number }> {
    // Validate commissioner
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can recalculate median results');
    }

    // Validate league has median enabled
    const league = await this.leagueRepo.findById(leagueId);
    if (!league?.leagueSettings?.useLeagueMedian) {
      throw new ValidationException('League median scoring is not enabled for this league');
    }

    // Validate week is finalized
    const matchups = await this.matchupsRepo.findByLeagueAndWeek(leagueId, season, week);
    if (matchups.length === 0) {
      throw new ValidationException(`No matchups found for week ${week}`);
    }
    const allFinalized = matchups.every((m) => m.isFinal);
    if (!allFinalized) {
      throw new ValidationException(`Week ${week} is not fully finalized`);
    }

    // Recalculate within transaction
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const medianPoints = await this.calculateAndStoreMedianResults(
        client,
        leagueId,
        season,
        week
      );

      await client.query('COMMIT');

      if (medianPoints === null) {
        throw new ValidationException('Unable to calculate median - insufficient teams');
      }

      return { medianPoints };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get the weekly median data for a specific week.
   * Returns null if no median results exist for the week.
   */
  async getWeeklyMedianData(
    leagueId: number,
    season: number,
    week: number
  ): Promise<WeeklyMedianData | null> {
    const result = await this.db.query(
      `SELECT median_points, roster_id, roster_points, result
       FROM weekly_median_results
       WHERE league_id = $1 AND season = $2 AND week = $3
       ORDER BY roster_points DESC`,
      [leagueId, season, week]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const medianPoints = parseFloat(result.rows[0].median_points);
    const results: MedianResult[] = result.rows.map((row) => ({
      rosterId: row.roster_id,
      points: parseFloat(row.roster_points),
      result: row.result as 'W' | 'L' | 'T',
    }));

    return {
      leagueId,
      season,
      week,
      medianPoints,
      results,
    };
  }
}
