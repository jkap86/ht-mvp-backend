/**
 * Rollover to New Season Use Case
 * Creates a new season for dynasty/keeper leagues without destroying historical data
 */

import { Pool, PoolClient } from 'pg';
import { runWithLock, LockDomain } from '../../../shared/transaction-runner';
import { LeagueRepository } from '../leagues.repository';
import { LeagueSeasonRepository } from '../league-season.repository';
import { LeagueSeason } from '../league-season.model';
import { League } from '../leagues.model';

export interface RolloverParams {
  leagueId: number;
  keeperDeadline?: Date;
  userId?: string; // For permission validation
}

export interface RolloverResult {
  newSeason: LeagueSeason;
  previousSeason: LeagueSeason;
}

export class RolloverToNewSeasonUseCase {
  constructor(
    private readonly pool: Pool,
    private readonly leagueRepo: LeagueRepository,
    private readonly leagueSeasonRepo: LeagueSeasonRepository
  ) {}

  async execute(params: RolloverParams): Promise<RolloverResult> {
    // Use LEAGUE lock domain (100M offset) - runWithLock manages transaction
    return runWithLock(this.pool, LockDomain.LEAGUE, params.leagueId, async (client) => {
      // 1. Validate league exists and mode supports rollover
      const league = await this.leagueRepo.findById(params.leagueId, client);
        if (!league) {
          throw new Error('League not found');
        }

        if (league.mode === 'redraft') {
          throw new Error('Redraft leagues should use reset, not rollover. Rollover is for dynasty/keeper/devy leagues only.');
        }

        // 2. Get current active season
        const currentSeason = await this.leagueSeasonRepo.findActiveByLeague(params.leagueId, client);
        if (!currentSeason) {
          throw new Error('No active season found to rollover from');
        }

        // 3. Verify current season is in completable state
        if (currentSeason.status === 'pre_draft') {
          throw new Error('Cannot rollover from pre_draft status. Complete the season first.');
        }

        // 4. Check if a newer season already exists
        const latestSeasonNumber = await this.leagueSeasonRepo.getLatestSeasonNumber(params.leagueId, client);
        if (latestSeasonNumber && latestSeasonNumber > currentSeason.season) {
          throw new Error('A newer season already exists. Cannot rollover again.');
        }

        // 5. Mark previous season as completed
        await this.leagueSeasonRepo.markCompleted(currentSeason.id, client);

        // 6. Create new season
        const newSeasonYear = currentSeason.season + 1;
        const keeperDeadline = params.keeperDeadline || new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

        const newSeason = await this.leagueSeasonRepo.create({
          leagueId: params.leagueId,
          season: newSeasonYear,
          status: 'pre_draft',
          seasonStatus: 'pre_season',
          currentWeek: 1,
          seasonSettings: {
            keeper_deadline: keeperDeadline.toISOString(),
            max_keepers: league.leagueSettings?.maxKeepers || 3,
            keeper_costs_enabled: league.leagueSettings?.keeperCostsEnabled || false
          }
        }, client);

        // 7. Copy rosters to new season (preserve ownership, reset players)
        await this.copyRostersToNewSeason(client, currentSeason.id, newSeason.id);

        // 8. Initialize waiver priorities (copy from previous season or inverse standings)
        await this.initializeWaiverPriorities(client, newSeason.id, currentSeason.id);

        // 9. Initialize FAAB budgets (reset to default)
        await this.initializeFAABBudgets(client, newSeason.id, league);

        // 10. Migrate future draft pick assets to new season
        await this.migrateDraftPickAssets(client, params.leagueId, newSeason.id, newSeasonYear);

      return {
        newSeason,
        previousSeason: currentSeason
      };
    });
  }

  /**
   * Copy rosters from old season to new season
   * Preserves: user_id, roster_id, settings
   * Resets: starters, bench (players will be added via keeper selection or draft)
   */
  private async copyRostersToNewSeason(
    client: PoolClient,
    oldSeasonId: number,
    newSeasonId: number
  ): Promise<void> {
    await client.query(
      `INSERT INTO rosters (league_season_id, user_id, roster_id, settings, starters, bench)
       SELECT $1, user_id, roster_id, settings, '[]'::jsonb, '[]'::jsonb
       FROM rosters
       WHERE league_season_id = $2
       ORDER BY roster_id`,
      [newSeasonId, oldSeasonId]
    );
  }

  /**
   * Initialize waiver priorities for new season
   * Strategy: Copy from previous season (can be inverse standings in future enhancement)
   */
  private async initializeWaiverPriorities(
    client: PoolClient,
    newSeasonId: number,
    oldSeasonId: number
  ): Promise<void> {
    const newSeason = await client.query(
      'SELECT season FROM league_seasons WHERE id = $1',
      [newSeasonId]
    );
    const seasonYear = newSeason.rows[0].season;

    // Copy waiver priorities from end of previous season
    // Map old roster IDs to new roster IDs via roster_id position
    await client.query(
      `INSERT INTO waiver_priority (league_season_id, roster_id, season, priority)
       SELECT $1, r_new.id, $2, wp.priority
       FROM waiver_priority wp
       JOIN rosters r_old ON wp.roster_id = r_old.id
       JOIN rosters r_new ON r_new.league_season_id = $1 AND r_new.roster_id = r_old.roster_id
       WHERE wp.league_season_id = $3
       ORDER BY wp.priority`,
      [newSeasonId, seasonYear, oldSeasonId]
    );
  }

  /**
   * Initialize FAAB budgets for new season (reset to league default)
   */
  private async initializeFAABBudgets(
    client: PoolClient,
    newSeasonId: number,
    league: League
  ): Promise<void> {
    const seasonYear = (await client.query(
      'SELECT season FROM league_seasons WHERE id = $1',
      [newSeasonId]
    )).rows[0].season;

    const initialBudget = league.leagueSettings?.faabBudget || 100;

    await client.query(
      `INSERT INTO faab_budgets (league_season_id, roster_id, season, initial_budget, remaining_budget)
       SELECT $1, id, $2, $3, $3
       FROM rosters
       WHERE league_season_id = $1`,
      [newSeasonId, seasonYear, initialBudget]
    );
  }

  /**
   * Migrate draft pick assets for the current season year
   * Pick assets for THIS season get league_season_id updated
   */
  private async migrateDraftPickAssets(
    client: PoolClient,
    leagueId: number,
    newSeasonId: number,
    newSeasonYear: number
  ): Promise<void> {
    // Update pick assets that match the new season year
    await client.query(
      `UPDATE draft_pick_assets
       SET league_season_id = $1
       WHERE league_id = $2 AND season = $3`,
      [newSeasonId, leagueId, newSeasonYear]
    );
  }
}
