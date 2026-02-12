import { Pool } from 'pg';
import { tryGetEventBus, EventTypes } from '../shared/events';
import { logger } from '../config/logger.config';

type SleeperSeasonType = 'preseason' | 'regular' | 'postseason';

/**
 * Auto-advance league weeks and season status based on NFL state from Sleeper API.
 *
 * Called from the stats-sync job on each cycle. Uses batch SQL updates for efficiency.
 * Runs under the stats-sync LeaderLock so no additional locking is needed.
 *
 * Safety guarantees:
 * - Forward-only: current_week < $1 guard prevents backward movement
 * - Idempotent: re-running with same NFL state produces no changes
 * - Non-fatal: wrapped in try/catch so stats sync continues on failure
 */
export async function checkAndAdvanceWeek(
  pool: Pool,
  nflSeason: number,
  nflWeek: number,
  nflSeasonType: SleeperSeasonType
): Promise<void> {
  try {
    const advancedLeagueIds = new Set<number>();

    // Step 1: Advance week for in-season leagues that are behind
    const weekResult = await pool.query<{ id: number; active_league_season_id: number | null }>(
      `UPDATE leagues SET current_week = $1, updated_at = CURRENT_TIMESTAMP
       WHERE season = $2::text
         AND season_status IN ('regular_season', 'playoffs')
         AND current_week < $1
       RETURNING id, active_league_season_id`,
      [nflWeek, nflSeason.toString()]
    );

    if (weekResult.rowCount && weekResult.rowCount > 0) {
      const leagueIds = weekResult.rows.map(r => r.id);
      leagueIds.forEach(id => advancedLeagueIds.add(id));
      logger.info(`Advanced ${weekResult.rowCount} leagues to week ${nflWeek}`);

      // Sync league_seasons current_week for leagues that have an active season
      const seasonIds = weekResult.rows
        .map(r => r.active_league_season_id)
        .filter((id): id is number => id != null);

      if (seasonIds.length > 0) {
        await pool.query(
          `UPDATE league_seasons SET current_week = $1, updated_at = CURRENT_TIMESTAMP
           WHERE id = ANY($2::int[])`,
          [nflWeek, seasonIds]
        );
      }
    }

    // Step 2: Advance season status (forward-only transitions)
    const statusAdvancedIds = await advanceSeasonStatus(pool, nflSeason, nflSeasonType);
    // Merge without duplicates (Set automatically handles dedup)
    statusAdvancedIds.forEach(id => advancedLeagueIds.add(id));

    // Step 3: Emit socket events after all DB writes
    if (advancedLeagueIds.size > 0) {
      const eventBus = tryGetEventBus();
      if (eventBus) {
        for (const leagueId of advancedLeagueIds) {
          eventBus.publish({
            type: EventTypes.LEAGUE_WEEK_ADVANCED,
            leagueId,
            payload: { week: nflWeek, seasonType: nflSeasonType },
          });
        }
      }
    }
  } catch (error) {
    logger.error(`Week advancement error: ${error}`);
  }
}

/**
 * Advance season status based on NFL season type.
 * Only performs forward transitions:
 * - pre_season -> regular_season (when Sleeper is 'regular' and draft is complete)
 * - regular_season -> playoffs (when Sleeper is 'postseason')
 *
 * Never auto-advances to offseason.
 */
async function advanceSeasonStatus(
  pool: Pool,
  nflSeason: number,
  nflSeasonType: SleeperSeasonType
): Promise<number[]> {
  const advancedIds: number[] = [];

  if (nflSeasonType === 'regular') {
    // pre_season -> regular_season, but only if the league's draft is complete
    // (league_seasons.status = 'in_season' means draft completed)
    const result = await pool.query<{ id: number; active_league_season_id: number | null }>(
      `UPDATE leagues l SET season_status = 'regular_season', updated_at = CURRENT_TIMESTAMP
       FROM league_seasons ls
       WHERE l.active_league_season_id = ls.id
         AND l.season = $1::text
         AND l.season_status = 'pre_season'
         AND ls.status = 'in_season'
       RETURNING l.id, l.active_league_season_id`,
      [nflSeason.toString()]
    );

    if (result.rowCount && result.rowCount > 0) {
      advancedIds.push(...result.rows.map(r => r.id));
      logger.info(`Advanced ${result.rowCount} leagues from pre_season to regular_season`);

      const seasonIds = result.rows
        .map(r => r.active_league_season_id)
        .filter((id): id is number => id != null);

      if (seasonIds.length > 0) {
        await pool.query(
          `UPDATE league_seasons SET season_status = 'regular_season', updated_at = CURRENT_TIMESTAMP
           WHERE id = ANY($1::int[])`,
          [seasonIds]
        );
      }
    }
  } else if (nflSeasonType === 'postseason') {
    // regular_season -> playoffs
    const result = await pool.query<{ id: number; active_league_season_id: number | null }>(
      `UPDATE leagues SET season_status = 'playoffs', updated_at = CURRENT_TIMESTAMP
       WHERE season = $1::text
         AND season_status = 'regular_season'
       RETURNING id, active_league_season_id`,
      [nflSeason.toString()]
    );

    if (result.rowCount && result.rowCount > 0) {
      advancedIds.push(...result.rows.map(r => r.id));
      logger.info(`Advanced ${result.rowCount} leagues from regular_season to playoffs`);

      const seasonIds = result.rows
        .map(r => r.active_league_season_id)
        .filter((id): id is number => id != null);

      if (seasonIds.length > 0) {
        await pool.query(
          `UPDATE league_seasons SET season_status = 'playoffs', updated_at = CURRENT_TIMESTAMP
           WHERE id = ANY($1::int[])`,
          [seasonIds]
        );
      }
    }
  }

  return advancedIds;
}
