import { DraftRepository } from './drafts.repository';
import { LeagueRepository } from '../leagues/leagues.repository';
import { RosterPlayersRepository } from '../rosters/rosters.repository';
import { ScheduleGeneratorService } from '../matchups/schedule-generator.service';
import { container, KEYS } from '../../container';
import { logger } from '../../config/env.config';

export interface PopulateRostersContext {
  draftRepo: DraftRepository;
  leagueRepo: LeagueRepository;
  rosterPlayersRepo: RosterPlayersRepository;
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
 */
export async function populateRostersFromDraft(
  ctx: PopulateRostersContext,
  draftId: number,
  leagueId: number
): Promise<void> {
  const picks = await ctx.draftRepo.getDraftPicks(draftId);
  const league = await ctx.leagueRepo.findById(leagueId);

  if (!league) {
    logger.warn(`Cannot populate rosters: league ${leagueId} not found`);
    return;
  }

  const season = parseInt(league.season, 10);
  let addedCount = 0;

  for (const pick of picks) {
    // Skip picks without a player (shouldn't happen for completed picks)
    if (pick.playerId === null) continue;

    try {
      await ctx.rosterPlayersRepo.addDraftedPlayer(
        pick.rosterId,
        pick.playerId,
        leagueId,
        season,
        0 // week 0 = draft
      );
      addedCount++;
    } catch (error: any) {
      // Player might already be on roster (e.g., if partial completion happened)
      if (error.code !== '23505') {
        // 23505 = unique_violation
        logger.warn(
          `Failed to add player ${pick.playerId} to roster ${pick.rosterId}: ${error.message}`
        );
      }
    }
  }

  logger.info(`Populated rosters from draft ${draftId} with ${addedCount}/${picks.length} picks`);
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
