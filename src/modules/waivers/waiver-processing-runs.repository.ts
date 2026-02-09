import { Pool, PoolClient } from 'pg';
import { WaiverProcessingRun, waiverProcessingRunFromDatabase } from './waivers.model';

/**
 * Repository for waiver processing runs.
 * Tracks processing executions to prevent duplicates and enable snapshotting.
 */
export class WaiverProcessingRunsRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Create a new processing run record.
   * Used at the START of waiver processing to establish a snapshot point.
   *
   * @param leagueId - League being processed
   * @param season - Season number
   * @param week - Week number
   * @param windowStartAt - The hour window when processing started (for deduplication)
   * @param client - Transaction client
   */
  async create(
    leagueId: number,
    season: number,
    week: number,
    windowStartAt: Date,
    client: PoolClient
  ): Promise<WaiverProcessingRun> {
    const result = await client.query(
      `INSERT INTO waiver_processing_runs (league_id, season, week, window_start_at)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [leagueId, season, week, windowStartAt]
    );
    return waiverProcessingRunFromDatabase(result.rows[0]);
  }

  /**
   * Try to create a processing run, returning null if one already exists for this window.
   * Uses UPSERT to atomically check and create.
   */
  async tryCreate(
    leagueId: number,
    season: number,
    week: number,
    windowStartAt: Date,
    client: PoolClient
  ): Promise<WaiverProcessingRun | null> {
    const result = await client.query(
      `INSERT INTO waiver_processing_runs (league_id, season, week, window_start_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (league_id, season, week, window_start_at) DO NOTHING
       RETURNING *`,
      [leagueId, season, week, windowStartAt]
    );

    if (result.rows.length === 0) {
      return null; // Already processed in this window
    }
    return waiverProcessingRunFromDatabase(result.rows[0]);
  }

  /**
   * Update the processing run with results.
   */
  async updateResults(
    processingRunId: number,
    claimsFound: number,
    claimsSuccessful: number,
    client: PoolClient
  ): Promise<WaiverProcessingRun> {
    const result = await client.query(
      `UPDATE waiver_processing_runs
       SET claims_found = $2, claims_successful = $3
       WHERE id = $1
       RETURNING *`,
      [processingRunId, claimsFound, claimsSuccessful]
    );
    return waiverProcessingRunFromDatabase(result.rows[0]);
  }

  /**
   * Find the most recent processing run for a league/week.
   */
  async findLatest(
    leagueId: number,
    season: number,
    week: number,
    client?: PoolClient
  ): Promise<WaiverProcessingRun | null> {
    const conn = client || this.db;
    const result = await conn.query(
      `SELECT * FROM waiver_processing_runs
       WHERE league_id = $1 AND season = $2 AND week = $3
       ORDER BY ran_at DESC
       LIMIT 1`,
      [leagueId, season, week]
    );
    return result.rows.length > 0 ? waiverProcessingRunFromDatabase(result.rows[0]) : null;
  }

  /**
   * Check if processing has already run for this window.
   */
  async hasRunInWindow(
    leagueId: number,
    season: number,
    week: number,
    windowStartAt: Date,
    client?: PoolClient
  ): Promise<boolean> {
    const conn = client || this.db;
    const result = await conn.query(
      `SELECT 1 FROM waiver_processing_runs
       WHERE league_id = $1 AND season = $2 AND week = $3 AND window_start_at = $4`,
      [leagueId, season, week, windowStartAt]
    );
    return result.rows.length > 0;
  }

  /**
   * Delete a processing run (for cleanup on failure).
   */
  async delete(processingRunId: number, client: PoolClient): Promise<boolean> {
    const result = await client.query(
      'DELETE FROM waiver_processing_runs WHERE id = $1',
      [processingRunId]
    );
    return (result.rowCount ?? 0) > 0;
  }
}
