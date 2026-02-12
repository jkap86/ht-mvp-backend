import { DraftRepository } from './drafts.repository';
import type { LeagueRepository } from '../leagues/leagues.repository';
import type { RosterPlayersRepository, RosterTransactionsRepository } from '../rosters/rosters.repository';
import type { RosterMutationService } from '../rosters/roster-mutation.service';
import type { ScheduleGeneratorService } from '../matchups/schedule-generator.service';
import { container, KEYS } from '../../container';
import { logger } from '../../config/logger.config';

export interface PopulateRostersContext {
  draftRepo: DraftRepository;
  leagueRepo: LeagueRepository;
  rosterPlayersRepo: RosterPlayersRepository;
  transactionsRepo?: RosterTransactionsRepository;
  rosterMutationService?: RosterMutationService;
}

export interface FinalizeDraftContext extends PopulateRostersContext {
  scheduleGeneratorService?: ScheduleGeneratorService;
}

/**
 * Populate rosters with drafted players when draft completes.
 * This ensures all draft picks are added to roster_players table.
 *
 * Centralized to avoid duplication across:
 * - BaseDraftEngine (autopick completion)
 * - DraftPickService (manual pick completion)
 * - DraftStateService (commissioner completion)
 *
 * IMPORTANT: Now validates roster size via RosterMutationService.
 * Uses skipOwnershipCheck because draft picks aren't in the roster system yet.
 *
 * @throws Error if more than the allowed failure threshold of picks fail to be added
 */
export async function populateRostersFromDraft(
  ctx: PopulateRostersContext,
  draftId: number,
  leagueId: number
): Promise<void> {
  const picks = await ctx.draftRepo.getDraftPicks(draftId);
  const league = await ctx.leagueRepo.findById(leagueId);

  if (!league) {
    throw new Error(`Cannot populate rosters: league ${leagueId} not found`);
  }

  const season = parseInt(league.season, 10);
  let addedCount = 0;
  let skippedCount = 0; // Duplicate picks (already on roster)
  let failedCount = 0;
  const failedDetails: Array<{ playerId: number; rosterId: number; error: string }> = [];

  // Get mutation service from container if not provided in context
  const mutationService =
    ctx.rosterMutationService ?? container.resolve<RosterMutationService>(KEYS.ROSTER_MUTATION_SERVICE);

  // Get transactions repo from container if not provided in context
  const transactionsRepo =
    ctx.transactionsRepo ?? container.resolve<RosterTransactionsRepository>(KEYS.ROSTER_TRANSACTIONS_REPO);

  for (const pick of picks) {
    // Skip picks without a player (shouldn't happen for completed picks)
    if (pick.playerId === null) continue;

    try {
      // Use mutation service with skipOwnershipCheck (player not in system yet)
      // Roster size IS validated - this is the critical fix!
      await mutationService.addPlayerToRoster(
        {
          rosterId: pick.rosterId,
          playerId: pick.playerId,
          leagueId,
          acquiredType: 'draft',
        },
        { skipOwnershipCheck: true }
      );

      // Record transaction
      await transactionsRepo.create(
        leagueId,
        pick.rosterId,
        pick.playerId,
        'add',
        season,
        0 // week 0 = draft
      );

      addedCount++;
    } catch (error: any) {
      // Player might already be on roster (e.g., if partial completion happened)
      if (error.code === '23505') {
        // 23505 = unique_violation - player already on roster, expected during retry
        skippedCount++;
      } else {
        failedCount++;
        failedDetails.push({
          playerId: pick.playerId,
          rosterId: pick.rosterId,
          error: error.message,
        });
        logger.warn(
          `Failed to add player ${pick.playerId} to roster ${pick.rosterId}: ${error.message}`
        );
      }
    }
  }

  logger.info(
    `Populated rosters from draft ${draftId}: added=${addedCount}, skipped=${skippedCount}, failed=${failedCount} of ${picks.length} picks`
  );

  // Fail if more than 2% of picks failed (excluding duplicates)
  // This threshold is intentionally strict because draft completion is a critical operation
  // and even a small number of failures could mean lost player assignments.
  const totalNonDuplicatePicks = picks.filter((p) => p.playerId !== null).length - skippedCount;
  const failureThreshold = Math.max(1, Math.ceil(totalNonDuplicatePicks * 0.02)); // At least 1, or 2%

  if (failedCount > failureThreshold) {
    const errorSummary = failedDetails
      .slice(0, 5)
      .map((d) => `player ${d.playerId} to roster ${d.rosterId}: ${d.error}`)
      .join('; ');
    throw new Error(
      `Draft completion failed: ${failedCount} picks could not be added to rosters. ` +
        `Threshold: ${failureThreshold}. Examples: ${errorSummary}`
    );
  }

  // Warn about any failures even if within threshold, so commissioners have visibility
  if (failedCount > 0 && failedCount <= failureThreshold) {
    logger.warn(
      `Draft ${draftId} completed with ${failedCount} failed picks (within threshold of ${failureThreshold})`,
      { failedDetails: failedDetails.slice(0, 10) }
    );
  }
}

/**
 * Unified function to finalize draft completion.
 * Ensures consistent side-effects across all completion paths:
 * - Manual pick (DraftPickService.makePick)
 * - Autopick (BaseDraftEngine.advanceToNextPick)
 * - Commissioner (DraftStateService.completeDraft)
 *
 * Side-effects:
 * 1. Populate rosters with drafted players
 * 2. Update league status to regular_season
 * 3. Generate schedule (14 weeks)
 */
export async function finalizeDraftCompletion(
  ctx: FinalizeDraftContext,
  draftId: number,
  leagueId: number
): Promise<void> {
  // 1. Populate rosters
  await populateRostersFromDraft(ctx, draftId, leagueId);

  // 2. Update league status
  await ctx.leagueRepo.update(leagueId, { status: 'regular_season' });

  // 3. Generate schedule (14 weeks)
  try {
    const scheduleService =
      ctx.scheduleGeneratorService ??
      container.resolve<ScheduleGeneratorService>(KEYS.SCHEDULE_GENERATOR_SERVICE);
    await scheduleService.generateScheduleSystem(leagueId, 14);
    logger.info(`Generated schedule for league ${leagueId} after draft ${draftId} completion`);
  } catch (error) {
    logger.error(`Failed to auto-generate schedule for league ${leagueId}:`, error);
  }
}
