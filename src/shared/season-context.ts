/**
 * Season context utilities for resolving the active league season.
 *
 * All season-scoped queries should use leagueSeasonId (from league_seasons table)
 * rather than league_id + season integer to ensure proper data isolation.
 */

import type { Pool, PoolClient } from 'pg';

/**
 * Resolve the active league_season_id for a league.
 * Uses leagues.active_league_season_id for O(1) lookup.
 *
 * @throws ValidationException if league has no active season configured
 */
export async function getActiveLeagueSeasonId(
  db: Pool | PoolClient,
  leagueId: number
): Promise<number> {
  const result = await db.query(
    'SELECT active_league_season_id FROM leagues WHERE id = $1',
    [leagueId]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(`League ${leagueId} not found`);
  }
  if (!row.active_league_season_id) {
    throw new Error(`No active season configured for league ${leagueId}`);
  }

  return row.active_league_season_id;
}

/**
 * Extract activeLeagueSeasonId from a League object, throwing if missing.
 * Prefer this over getActiveLeagueSeasonId when you already have the League loaded.
 */
export function requireActiveLeagueSeasonId(league: { id: number; activeLeagueSeasonId?: number }): number {
  if (!league.activeLeagueSeasonId) {
    throw new Error(`No active season configured for league ${league.id}`);
  }
  return league.activeLeagueSeasonId;
}
