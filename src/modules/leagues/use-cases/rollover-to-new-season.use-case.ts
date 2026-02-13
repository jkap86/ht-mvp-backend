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
import { LeagueOperationsRepository } from '../league-operations.repository';
import {
  NotFoundException,
  ValidationException,
  ConflictException,
  ForbiddenException,
} from '../../../utils/exceptions';

export interface RolloverParams {
  leagueId: number;
  keeperDeadline?: Date;
  userId?: string; // For permission validation
  idempotencyKey?: string;
}

export interface RolloverResult {
  newSeason: LeagueSeason;
  previousSeason: LeagueSeason;
}

export class RolloverToNewSeasonUseCase {
  constructor(
    private readonly pool: Pool,
    private readonly leagueRepo: LeagueRepository,
    private readonly leagueSeasonRepo: LeagueSeasonRepository,
    private readonly leagueOpsRepo: LeagueOperationsRepository
  ) {}

  async execute(params: RolloverParams): Promise<RolloverResult> {
    // Use LEAGUE lock domain (100M offset) - runWithLock manages transaction
    return runWithLock(this.pool, LockDomain.LEAGUE, params.leagueId, async (client) => {
      // 0. Idempotency check
      if (params.idempotencyKey && params.userId) {
        const existingOp = await this.leagueOpsRepo.findByKey(
          params.leagueId,
          params.userId,
          params.idempotencyKey,
          client
        );
        if (existingOp) {
          return existingOp.responseData as RolloverResult;
        }
      }

      // 1. Validate league exists and mode supports rollover
      const league = await this.leagueRepo.findById(params.leagueId, client);
      if (!league) {
        throw new NotFoundException('League not found');
      }

      // 1b. Validate commissioner permission
      if (!params.userId) {
        throw new ForbiddenException('userId is required for rollover');
      }
      const isCommish = await this.leagueRepo.isCommissioner(params.leagueId, params.userId);
      if (!isCommish) {
        throw new ForbiddenException('Only the commissioner can rollover a league season');
      }

      if (league.mode === 'redraft') {
        throw new ValidationException(
          'Redraft leagues should use reset, not rollover. Rollover is for dynasty/keeper/devy leagues only.'
        );
      }

      // 2. Get current active season
      const currentSeason = await this.leagueSeasonRepo.findActiveByLeague(params.leagueId, client);
      if (!currentSeason) {
        throw new NotFoundException('No active season found to rollover from');
      }

      // 3. Verify current season is in completable state
      if (currentSeason.status === 'pre_draft') {
        throw new ValidationException(
          'Cannot rollover from pre_draft status. Complete the season first.'
        );
      }

      // 4. Check if a newer season already exists
      const latestSeasonNumber = await this.leagueSeasonRepo.getLatestSeasonNumber(
        params.leagueId,
        client
      );
      if (latestSeasonNumber && latestSeasonNumber > currentSeason.season) {
        throw new ConflictException('A newer season already exists. Cannot rollover again.');
      }

      // 5. Mark previous season as completed
      await this.leagueSeasonRepo.markCompleted(currentSeason.id, client);

      // 6. Create new season
      const newSeasonYear = currentSeason.season + 1;
      const keeperDeadline =
        params.keeperDeadline || new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

      const newSeason = await this.leagueSeasonRepo.create(
        {
          leagueId: params.leagueId,
          season: newSeasonYear,
          status: 'pre_draft',
          seasonStatus: 'pre_season',
          currentWeek: 1,
          seasonSettings: {
            keeper_deadline: keeperDeadline.toISOString(),
            max_keepers: league.leagueSettings?.maxKeepers || 3,
            keeper_costs_enabled: league.leagueSettings?.keeperCostsEnabled || false,
          },
        },
        client
      );

      // 7. Copy rosters to new season (preserve ownership, reset players)
      await this.copyRostersToNewSeason(client, currentSeason.id, newSeason.id, params.leagueId);

      // 8. Initialize waiver priorities (copy from previous season or inverse standings)
      await this.initializeWaiverPriorities(
        client,
        newSeason.id,
        currentSeason.id,
        params.leagueId
      );

      // 9. Initialize FAAB budgets (reset to default)
      await this.initializeFAABBudgets(client, newSeason.id, league, params.leagueId);

      // 10. Migrate future draft pick assets to new season
      await this.migrateDraftPickAssets(
        client,
        params.leagueId,
        newSeason.id,
        newSeasonYear,
        currentSeason.id
      );

      // 11. Update active season pointer + sync league-level fields
      await client.query(
        `UPDATE leagues
           SET active_league_season_id = $1,
               season = $2::text,
               current_week = 1,
               status = 'pre_draft',
               season_status = 'pre_season',
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
        [newSeason.id, newSeasonYear, params.leagueId]
      );

      const result = {
        newSeason,
        previousSeason: currentSeason,
      };

      // 12. Store idempotency result
      if (params.idempotencyKey && params.userId) {
        await this.leagueOpsRepo.create(
          params.leagueId,
          params.userId,
          'rollover',
          params.idempotencyKey,
          result,
          client
        );
      }

      return result;
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
    newSeasonId: number,
    leagueId: number
  ): Promise<void> {
    await client.query(
      `INSERT INTO rosters (league_id, league_season_id, user_id, roster_id, settings, starters, bench)
       SELECT $3, $1, user_id, roster_id, settings, '[]'::jsonb, '[]'::jsonb
       FROM rosters
       WHERE league_season_id = $2
       ORDER BY roster_id`,
      [newSeasonId, oldSeasonId, leagueId]
    );
  }

  /**
   * Initialize waiver priorities for new season
   * Strategy: Copy from previous season (can be inverse standings in future enhancement)
   */
  private async initializeWaiverPriorities(
    client: PoolClient,
    newSeasonId: number,
    oldSeasonId: number,
    leagueId: number
  ): Promise<void> {
    const newSeason = await client.query('SELECT season FROM league_seasons WHERE id = $1', [
      newSeasonId,
    ]);
    const seasonYear = newSeason.rows[0].season;

    // Copy waiver priorities from end of previous season
    // Map old roster IDs to new roster IDs via roster_id position
    await client.query(
      `INSERT INTO waiver_priority (league_id, league_season_id, roster_id, season, priority)
       SELECT $4, $1, r_new.id, $2, wp.priority
       FROM waiver_priority wp
       JOIN rosters r_old ON wp.roster_id = r_old.id
       JOIN rosters r_new ON r_new.league_season_id = $1 AND r_new.roster_id = r_old.roster_id
       WHERE wp.league_season_id = $3
       ORDER BY wp.priority`,
      [newSeasonId, seasonYear, oldSeasonId, leagueId]
    );
  }

  /**
   * Initialize FAAB budgets for new season (reset to league default)
   */
  private async initializeFAABBudgets(
    client: PoolClient,
    newSeasonId: number,
    league: League,
    leagueId: number
  ): Promise<void> {
    const seasonYear = (
      await client.query('SELECT season FROM league_seasons WHERE id = $1', [newSeasonId])
    ).rows[0].season;

    const initialBudget = league.leagueSettings?.faabBudget || 100;

    await client.query(
      `INSERT INTO faab_budgets (league_id, league_season_id, roster_id, season, initial_budget, remaining_budget)
       SELECT $4, $1, id, $2, $3, $3
       FROM rosters
       WHERE league_season_id = $1`,
      [newSeasonId, seasonYear, initialBudget, leagueId]
    );
  }

  /**
   * Migrate draft pick assets during rollover:
   * 1. Set league_season_id for picks matching the new season year
   * 2. Remap original_roster_id and current_owner_roster_id from old-season
   *    roster rows to new-season roster rows for all current + future picks.
   *    (rosters.id is SERIAL and changes each season; the stable identifier
   *    is rosters.roster_id which is preserved across rollovers.)
   */
  private async migrateDraftPickAssets(
    client: PoolClient,
    leagueId: number,
    newSeasonId: number,
    newSeasonYear: number,
    _oldSeasonId: number
  ): Promise<void> {
    // Step 1: Update league_season_id for picks matching the new season year
    await client.query(
      `UPDATE draft_pick_assets
       SET league_season_id = $1
       WHERE league_id = $2 AND season = $3`,
      [newSeasonId, leagueId, newSeasonYear]
    );

    // Step 2: Remap original_roster_id for all current/future picks
    // that still reference old-season rosters
    await client.query(
      `UPDATE draft_pick_assets dpa
       SET original_roster_id = r_new.id
       FROM rosters r_old
       JOIN rosters r_new
         ON r_new.roster_id = r_old.roster_id
        AND r_new.league_season_id = $1
       WHERE dpa.league_id = $2
         AND dpa.season >= $3
         AND dpa.original_roster_id = r_old.id
         AND r_old.league_season_id != $1`,
      [newSeasonId, leagueId, newSeasonYear]
    );

    // Step 3: Remap current_owner_roster_id for all current/future picks
    // that still reference old-season rosters
    await client.query(
      `UPDATE draft_pick_assets dpa
       SET current_owner_roster_id = r_new.id
       FROM rosters r_old
       JOIN rosters r_new
         ON r_new.roster_id = r_old.roster_id
        AND r_new.league_season_id = $1
       WHERE dpa.league_id = $2
         AND dpa.season >= $3
         AND dpa.current_owner_roster_id = r_old.id
         AND r_old.league_season_id != $1`,
      [newSeasonId, leagueId, newSeasonYear]
    );
  }
}
