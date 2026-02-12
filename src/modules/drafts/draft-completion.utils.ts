import { Pool, PoolClient } from 'pg';
import { DraftRepository } from './drafts.repository';
import type { LeagueRepository } from '../leagues/leagues.repository';
import type { RosterPlayersRepository, RosterTransactionsRepository } from '../rosters/rosters.repository';
import type { RosterMutationService } from '../rosters/roster-mutation.service';
import type { ScheduleGeneratorService } from '../matchups/schedule-generator.service';
import { container, KEYS } from '../../container';
import { logger } from '../../config/logger.config';
import { runInTransaction } from '../../shared/transaction-runner';
import { tryGetEventBus, EventTypes } from '../../shared/events';
import { NotFoundException, ValidationException } from '../../utils/exceptions';

/**
 * Thrown when draft completion succeeds (rosters populated, league status updated)
 * but a post-completion step like schedule generation fails.
 *
 * Callers should handle this gracefully: the draft IS complete, but the league
 * may need manual intervention for the failed step.
 */
export class PartialCompletionError extends Error {
  public readonly draftId: number;
  public readonly leagueId: number;
  public readonly cause: unknown;

  constructor(message: string, draftId: number, leagueId: number, cause: unknown) {
    super(message);
    this.name = 'PartialCompletionError';
    this.draftId = draftId;
    this.leagueId = leagueId;
    this.cause = cause;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Result of draft completion, indicating whether all steps succeeded.
 */
export interface DraftCompletionResult {
  /** Whether all completion steps succeeded */
  success: boolean;
  /** Whether schedule generation specifically failed */
  scheduleGenerationFailed: boolean;
  /** Error details if schedule generation failed */
  scheduleError?: string;
}

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
 * TRANSACTION: When a client is provided, all roster additions are executed
 * within the caller's transaction (atomic). When no client is provided, a new
 * transaction is created internally to ensure atomicity.
 *
 * @throws Error if more than the allowed failure threshold of picks fail to be added
 */
export async function populateRostersFromDraft(
  ctx: PopulateRostersContext,
  draftId: number,
  leagueId: number,
  client?: PoolClient
): Promise<void> {
  const picks = client
    ? await ctx.draftRepo.getDraftPicksWithClient(client, draftId)
    : await ctx.draftRepo.getDraftPicks(draftId);
  const league = await ctx.leagueRepo.findById(leagueId, client);

  if (!league) {
    throw new NotFoundException(`Cannot populate rosters: league ${leagueId} not found`);
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
      // Pass client for transactional atomicity
      await mutationService.addPlayerToRoster(
        {
          rosterId: pick.rosterId,
          playerId: pick.playerId,
          leagueId,
          acquiredType: 'draft',
        },
        { skipOwnershipCheck: true },
        client
      );

      // Record transaction (pass client for atomicity)
      await transactionsRepo.create(
        leagueId,
        pick.rosterId,
        pick.playerId,
        'add',
        season,
        0, // week 0 = draft
        undefined,
        client
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
    throw new ValidationException(
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
 * Populate matchups table from matchups draft picks.
 * Reads pick_metadata from draft_picks and creates matchup entries.
 *
 * @param draftRepo - Draft repository for accessing pick data
 * @param draftId - The matchups draft ID
 * @param leagueId - The league ID
 * @param client - Transaction client for atomicity
 */
async function populateMatchupsFromDraft(
  draftRepo: DraftRepository,
  draftId: number,
  leagueId: number,
  client: PoolClient
): Promise<void> {
  // Get league info for season
  const league = await client.query('SELECT season FROM leagues WHERE id = $1', [leagueId]);
  if (league.rows.length === 0) {
    throw new NotFoundException(`League ${leagueId} not found`);
  }
  const season = parseInt(league.rows[0].season, 10);

  // Get all matchup picks (only positive pick_numbers, not reciprocal negatives)
  const picks = await client.query(
    `SELECT roster_id, pick_metadata FROM draft_picks
     WHERE draft_id = $1 AND pick_metadata IS NOT NULL AND pick_number > 0
     ORDER BY pick_number`,
    [draftId]
  );

  if (picks.rows.length === 0) {
    throw new ValidationException(`No matchup picks found for draft ${draftId}`);
  }

  // Create matchup entries from picks
  let createdCount = 0;
  for (const row of picks.rows) {
    const rosterId = row.roster_id;
    const metadata = row.pick_metadata as { week: number; opponentRosterId: number };
    const week = metadata.week;
    const opponentRosterId = metadata.opponentRosterId;

    // Ensure canonical ordering (lower rosterId first) to avoid duplicates
    const [roster1Id, roster2Id] =
      rosterId < opponentRosterId ? [rosterId, opponentRosterId] : [opponentRosterId, rosterId];

    // Check if matchup already exists (idempotency)
    const existing = await client.query(
      `SELECT id FROM matchups
       WHERE league_id = $1 AND season = $2 AND week = $3
       AND roster1_id = $4 AND roster2_id = $5`,
      [leagueId, season, week, roster1Id, roster2Id]
    );

    if (existing.rows.length > 0) {
      continue; // Already exists, skip
    }

    // Insert matchup
    await client.query(
      `INSERT INTO matchups (league_id, season, week, roster1_id, roster2_id, is_playoff, generated_from_draft_id)
       VALUES ($1, $2, $3, $4, $5, false, $6)`,
      [leagueId, season, week, roster1Id, roster2Id, draftId]
    );

    createdCount++;
  }

  logger.info(
    `Populated ${createdCount} matchups from matchups draft ${draftId} for league ${leagueId}`
  );
}

/**
 * Unified function to finalize draft completion.
 * Ensures consistent side-effects across all completion paths:
 * - Manual pick (DraftPickService.makePick)
 * - Autopick (BaseDraftEngine.advanceToNextPick)
 * - Commissioner (DraftStateService.completeDraft)
 *
 * Side-effects:
 * 1. Set roster_population_status to 'pending'
 * 2. Populate rosters with drafted players (atomic transaction)
 * 3. Set roster_population_status to 'complete'
 * 4. Update league status to regular_season
 * 5. Generate schedule (14 weeks)
 *
 * TRANSACTION: When a client is provided, roster population runs within the
 * caller's transaction. When no client is provided, a new transaction is created
 * internally. The roster_population_status field tracks progress so that retries
 * are possible on startup if the process crashes.
 *
 * SCHEDULE GENERATION: If schedule generation fails, the function does NOT throw.
 * Instead, it returns a DraftCompletionResult with scheduleGenerationFailed=true
 * and emits a LEAGUE_UPDATED domain event with action='schedule_generation_failed'
 * to notify the commissioner via socket/push. This design ensures that the
 * transaction commits successfully (rosters + league status) even if schedule
 * generation fails. Callers that need to surface this to the user should check
 * the result.
 *
 * @returns DraftCompletionResult indicating overall success and schedule status
 */
export async function finalizeDraftCompletion(
  ctx: FinalizeDraftContext,
  draftId: number,
  leagueId: number,
  client?: PoolClient
): Promise<DraftCompletionResult> {
  if (client) {
    // We have a transaction client - run everything within it
    return await finalizeDraftCompletionWithClient(ctx, draftId, leagueId, client);
  } else {
    // No client provided - create a transaction for roster population
    const pool = container.resolve<Pool>(KEYS.POOL);
    return await runInTransaction(pool, async (txClient) => {
      return await finalizeDraftCompletionWithClient(ctx, draftId, leagueId, txClient);
    });
  }
}

/**
 * Internal implementation that runs within a transaction client.
 * Handles roster population atomically with status tracking.
 *
 * Returns a DraftCompletionResult so the caller can decide how to handle
 * partial failures (e.g., schedule generation) without rolling back the
 * transaction that committed rosters and league status.
 */
async function finalizeDraftCompletionWithClient(
  ctx: FinalizeDraftContext,
  draftId: number,
  leagueId: number,
  client: PoolClient
): Promise<DraftCompletionResult> {
  // 1. Mark roster population as pending (enables retry detection on startup)
  await ctx.draftRepo.updateWithClient(client, draftId, {
    rosterPopulationStatus: 'pending',
  });

  try {
    // 2. Populate rosters atomically within this transaction
    await populateRostersFromDraft(ctx, draftId, leagueId, client);

    // 3. Mark roster population as complete
    await ctx.draftRepo.updateWithClient(client, draftId, {
      rosterPopulationStatus: 'complete',
    });
  } catch (error) {
    // Mark roster population as failed so retries can be triggered
    // Note: if the transaction rolls back, this update also rolls back.
    // The caller's catch handler will set the status via a separate connection if needed.
    logger.error(`Roster population failed for draft ${draftId}:`, error);

    // Try to mark as failed within the same transaction
    // If the whole transaction rolls back, the status will remain null/pending,
    // which is also detectable for retries.
    try {
      await ctx.draftRepo.updateWithClient(client, draftId, {
        rosterPopulationStatus: 'failed',
      });
    } catch (statusError) {
      // If we can't even update the status, the transaction is likely already
      // in a bad state. Let the error propagate.
      logger.error(`Failed to mark roster population as failed for draft ${draftId}:`, statusError);
    }

    throw error;
  }

  // 4. Update league status within the same transaction
  await client.query(
    `UPDATE leagues SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    ['regular_season', leagueId]
  );

  // 5. Check if this is a matchups draft - if so, populate matchups table from draft picks
  const draft = await ctx.draftRepo.findByIdWithClient(client, draftId);
  if (!draft) {
    throw new NotFoundException(`Draft ${draftId} not found`);
  }

  if (draft.draftType === 'matchups') {
    // For matchups drafts, populate matchups table from pick metadata
    await populateMatchupsFromDraft(ctx.draftRepo, draftId, leagueId, client);
    logger.info(`Populated matchups table from matchups draft ${draftId}`);
    return { success: true, scheduleGenerationFailed: false };
  }

  // 6. For non-matchups drafts, generate schedule (14 weeks)
  // This runs within the transaction but schedule generation uses its own connections.
  // If it fails, we still want the transaction to commit (draft IS complete),
  // so we catch the error and return it as a result instead of throwing.
  try {
    const scheduleService =
      ctx.scheduleGeneratorService ??
      container.resolve<ScheduleGeneratorService>(KEYS.SCHEDULE_GENERATOR_SERVICE);
    await scheduleService.generateScheduleSystem(leagueId, 14);
    logger.info(`Generated schedule for league ${leagueId} after draft ${draftId} completion`);
    return { success: true, scheduleGenerationFailed: false };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Log at error level with full details for operational visibility
    logger.error(
      `Schedule generation failed for league ${leagueId} after draft ${draftId} completion. ` +
        `The league has been moved to regular_season but has NO matchup schedule. ` +
        `Commissioner intervention required.`,
      error
    );

    // Emit a domain event so the commissioner is notified via socket/push
    try {
      const eventBus = tryGetEventBus();
      if (eventBus) {
        eventBus.publish({
          type: EventTypes.LEAGUE_UPDATED,
          leagueId,
          payload: {
            action: 'schedule_generation_failed',
            draftId,
            leagueId,
            error: errorMessage,
            message:
              'Draft completed successfully but schedule generation failed. ' +
              'Please generate the schedule manually from league settings.',
          },
        });
      }
    } catch (eventError) {
      // Don't let event publishing failure mask the original error
      logger.error(`Failed to emit schedule generation failure event for league ${leagueId}:`, eventError);
    }

    // Return the failure as a result (do NOT throw -- let the transaction commit)
    return {
      success: false,
      scheduleGenerationFailed: true,
      scheduleError: errorMessage,
    };
  }
}
