/**
 * LeagueSeasonRepository
 * Repository for managing league seasons (competitive years)
 */

import { Pool, PoolClient } from 'pg';
import {
  LeagueSeason,
  CreateLeagueSeasonParams,
  UpdateLeagueSeasonParams,
  SeasonStatus,
  PhaseStatus,
} from './league-season.model';
import { NotFoundException } from '../../utils/exceptions';

export class LeagueSeasonRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Find a league season by ID
   */
  async findById(id: number, client?: PoolClient): Promise<LeagueSeason | null> {
    const executor = client || this.pool;
    const result = await executor.query('SELECT * FROM league_seasons WHERE id = $1', [id]);
    return result.rows[0] ? LeagueSeason.fromDatabase(result.rows[0]) : null;
  }

  /**
   * Find a league season by league ID and season year
   */
  async findByLeagueAndSeason(
    leagueId: number,
    season: number,
    client?: PoolClient
  ): Promise<LeagueSeason | null> {
    const executor = client || this.pool;
    const result = await executor.query(
      'SELECT * FROM league_seasons WHERE league_id = $1 AND season = $2',
      [leagueId, season]
    );
    return result.rows[0] ? LeagueSeason.fromDatabase(result.rows[0]) : null;
  }

  /**
   * Find the active (current) season for a league
   * Returns the most recent non-completed season
   */
  async findActiveByLeague(leagueId: number, client?: PoolClient): Promise<LeagueSeason | null> {
    const executor = client || this.pool;
    const result = await executor.query(
      `SELECT * FROM league_seasons
       WHERE league_id = $1
       AND status IN ('pre_draft', 'drafting', 'in_season', 'playoffs')
       ORDER BY season DESC
       LIMIT 1`,
      [leagueId]
    );
    return result.rows[0] ? LeagueSeason.fromDatabase(result.rows[0]) : null;
  }

  /**
   * Get the active (current) season for a league or throw if not found.
   * Centralizes active season resolution to prevent drift.
   */
  async getActiveLeagueSeasonOrThrow(leagueId: number, client?: PoolClient): Promise<LeagueSeason> {
    const season = await this.findActiveByLeague(leagueId, client);
    if (!season) {
      throw new NotFoundException(`No active season found for league ${leagueId}`);
    }
    return season;
  }

  /**
   * Find all seasons for a league (ordered by season desc)
   */
  async findAllByLeague(leagueId: number, client?: PoolClient): Promise<LeagueSeason[]> {
    const executor = client || this.pool;
    const result = await executor.query(
      'SELECT * FROM league_seasons WHERE league_id = $1 ORDER BY season DESC',
      [leagueId]
    );
    return result.rows.map(LeagueSeason.fromDatabase);
  }

  /**
   * Find all completed seasons for a league
   */
  async findCompletedByLeague(leagueId: number, client?: PoolClient): Promise<LeagueSeason[]> {
    const executor = client || this.pool;
    const result = await executor.query(
      `SELECT * FROM league_seasons
       WHERE league_id = $1 AND status = 'completed'
       ORDER BY season DESC`,
      [leagueId]
    );
    return result.rows.map(LeagueSeason.fromDatabase);
  }

  /**
   * Create a new league season
   */
  async create(params: CreateLeagueSeasonParams, client?: PoolClient): Promise<LeagueSeason> {
    const executor = client || this.pool;
    const result = await executor.query(
      `INSERT INTO league_seasons (
        league_id, season, status, season_status, current_week,
        season_settings, started_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *`,
      [
        params.leagueId,
        params.season,
        params.status || 'pre_draft',
        params.seasonStatus || 'pre_season',
        params.currentWeek || 1,
        JSON.stringify(params.seasonSettings || {}),
        params.startedAt || null,
      ]
    );
    return LeagueSeason.fromDatabase(result.rows[0]);
  }

  /**
   * Update a league season
   */
  async update(
    id: number,
    updates: UpdateLeagueSeasonParams,
    client?: PoolClient
  ): Promise<LeagueSeason> {
    const executor = client || this.pool;

    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`);
      values.push(updates.status);
    }
    if (updates.seasonStatus !== undefined) {
      setClauses.push(`season_status = $${paramIndex++}`);
      values.push(updates.seasonStatus);
    }
    if (updates.currentWeek !== undefined) {
      setClauses.push(`current_week = $${paramIndex++}`);
      values.push(updates.currentWeek);
    }
    if (updates.seasonSettings !== undefined) {
      setClauses.push(`season_settings = $${paramIndex++}`);
      values.push(JSON.stringify(updates.seasonSettings));
    }
    if (updates.startedAt !== undefined) {
      setClauses.push(`started_at = $${paramIndex++}`);
      values.push(updates.startedAt);
    }
    if (updates.completedAt !== undefined) {
      setClauses.push(`completed_at = $${paramIndex++}`);
      values.push(updates.completedAt);
    }

    setClauses.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const query = `
      UPDATE league_seasons
      SET ${setClauses.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    const result = await executor.query(query, values);
    if (result.rows.length === 0) {
      throw new Error(`LeagueSeason with id ${id} not found`);
    }
    return LeagueSeason.fromDatabase(result.rows[0]);
  }

  /**
   * Update season status
   */
  async updateStatus(id: number, status: SeasonStatus, client?: PoolClient): Promise<void> {
    const executor = client || this.pool;
    await executor.query(
      'UPDATE league_seasons SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [status, id]
    );
  }

  /**
   * Update season phase status
   */
  async updateSeasonStatus(
    id: number,
    seasonStatus: PhaseStatus,
    client?: PoolClient
  ): Promise<void> {
    const executor = client || this.pool;
    await executor.query(
      'UPDATE league_seasons SET season_status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [seasonStatus, id]
    );
  }

  /**
   * Mark season as completed
   */
  async markCompleted(id: number, client?: PoolClient): Promise<void> {
    const executor = client || this.pool;
    await executor.query(
      `UPDATE league_seasons
       SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [id]
    );
  }

  /**
   * Update current week
   */
  async updateCurrentWeek(id: number, week: number, client?: PoolClient): Promise<void> {
    const executor = client || this.pool;
    await executor.query(
      'UPDATE league_seasons SET current_week = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [week, id]
    );
  }

  /**
   * Update season settings (merge with existing settings)
   */
  async updateSettings(
    id: number,
    settingsUpdate: Record<string, any>,
    client?: PoolClient
  ): Promise<void> {
    const executor = client || this.pool;
    await executor.query(
      `UPDATE league_seasons
       SET season_settings = season_settings || $1::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [JSON.stringify(settingsUpdate), id]
    );
  }

  /**
   * Check if a league has any active seasons
   */
  async hasActiveSeason(leagueId: number, client?: PoolClient): Promise<boolean> {
    const executor = client || this.pool;
    const result = await executor.query(
      `SELECT COUNT(*) as count FROM league_seasons
       WHERE league_id = $1 AND status IN ('pre_draft', 'drafting', 'in_season', 'playoffs')`,
      [leagueId]
    );
    return (Number(result.rows[0].count) || 0) > 0;
  }

  /**
   * Get the latest season number for a league
   */
  async getLatestSeasonNumber(leagueId: number, client?: PoolClient): Promise<number | null> {
    const executor = client || this.pool;
    const result = await executor.query(
      'SELECT MAX(season) as max_season FROM league_seasons WHERE league_id = $1',
      [leagueId]
    );
    return result.rows[0].max_season || null;
  }

  /**
   * Delete a league season (use with caution - prefer marking as completed)
   */
  async delete(id: number, client?: PoolClient): Promise<void> {
    const executor = client || this.pool;
    await executor.query('DELETE FROM league_seasons WHERE id = $1', [id]);
  }
}
