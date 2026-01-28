import { IDraftEngine, DraftTickResult, NextPickDetails } from './draft-engine.interface';
import { Draft, DraftOrderEntry, DraftPick, draftToResponse } from '../modules/drafts/drafts.model';
import { DraftRepository, QueueEntry } from '../modules/drafts/drafts.repository';
import { PlayerRepository } from '../modules/players/players.repository';
import { RosterPlayersRepository } from '../modules/rosters/rosters.repository';
import { LeagueRepository } from '../modules/leagues/leagues.repository';
import { tryGetSocketService } from '../socket';
import { logger } from '../config/env.config';

/**
 * Abstract base class for draft engines.
 * Provides shared logic for pick calculation and autopick.
 * Subclasses implement getPickerForPickNumber for draft-type-specific order.
 */
export abstract class BaseDraftEngine implements IDraftEngine {
  abstract readonly draftType: string;

  constructor(
    protected readonly draftRepo: DraftRepository,
    protected readonly playerRepo: PlayerRepository,
    protected readonly rosterPlayersRepo: RosterPlayersRepository,
    protected readonly leagueRepo: LeagueRepository
  ) {}

  /**
   * Get the roster that should pick at a given pick number.
   * Must be implemented by subclasses for specific draft type logic.
   */
  abstract getPickerForPickNumber(
    draft: Draft,
    draftOrder: DraftOrderEntry[],
    pickNumber: number
  ): DraftOrderEntry | undefined;

  /**
   * Calculate pick position within round (1-indexed)
   */
  getPickInRound(pickNumber: number, totalRosters: number): number {
    return ((pickNumber - 1) % totalRosters) + 1;
  }

  /**
   * Calculate round number (1-indexed)
   */
  getRound(pickNumber: number, totalRosters: number): number {
    return Math.ceil(pickNumber / totalRosters);
  }

  /**
   * Check if draft is complete
   */
  isDraftComplete(draft: Draft, afterPickNumber: number): boolean {
    // Need draft order to calculate total picks, but we can use rounds * rosters
    // For now, we'll check in getNextPickDetails which has access to draftOrder
    return false; // Handled in getNextPickDetails
  }

  /**
   * Get next pick details after current pick
   */
  getNextPickDetails(draft: Draft, draftOrder: DraftOrderEntry[]): NextPickDetails | null {
    const totalRosters = draftOrder.length;
    const totalPicks = totalRosters * draft.rounds;
    const nextPickNumber = draft.currentPick + 1;

    if (nextPickNumber > totalPicks) {
      return null; // Draft complete
    }

    const nextRound = this.getRound(nextPickNumber, totalRosters);
    const nextPicker = this.getPickerForPickNumber(draft, draftOrder, nextPickNumber);

    if (!nextPicker) {
      return null;
    }

    return {
      currentPick: nextPickNumber,
      currentRound: nextRound,
      currentRosterId: nextPicker.rosterId,
      pickDeadline: this.calculatePickDeadline(draft),
      status: 'in_progress',
    };
  }

  /**
   * Check if autopick should trigger based on deadline
   */
  shouldAutoPick(draft: Draft): boolean {
    if (draft.status !== 'in_progress') return false;
    if (!draft.pickDeadline) return false;
    return new Date() >= draft.pickDeadline;
  }

  /**
   * Calculate next pick deadline
   */
  calculatePickDeadline(draft: Draft): Date {
    const deadline = new Date();
    deadline.setSeconds(deadline.getSeconds() + draft.pickTimeSeconds);
    return deadline;
  }

  /**
   * Populate rosters with drafted players when draft completes.
   * This ensures all draft picks are added to roster_players table.
   */
  protected async populateRostersFromDraft(draftId: number, leagueId: number): Promise<void> {
    const picks = await this.draftRepo.getDraftPicks(draftId);
    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      logger.warn(`Cannot populate rosters: league ${leagueId} not found`);
      return;
    }

    const season = parseInt(league.season, 10);

    for (const pick of picks) {
      // Skip picks without a player (shouldn't happen for completed picks)
      if (pick.playerId === null) continue;

      try {
        await this.rosterPlayersRepo.addDraftedPlayer(
          pick.rosterId,
          pick.playerId,
          leagueId,
          season,
          0 // week 0 = draft
        );
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

    logger.info(`Populated rosters from draft ${draftId} with ${picks.length} picks`);
  }

  /**
   * Process a tick - check for expired picks and autopick if needed
   */
  async tick(draftId: number): Promise<DraftTickResult> {
    const draft = await this.draftRepo.findById(draftId);

    if (!draft) {
      return {
        actionTaken: false,
        draftCompleted: false,
        draft: draft!,
        reason: 'none',
      };
    }

    if (draft.status !== 'in_progress') {
      return {
        actionTaken: false,
        draftCompleted: draft.status === 'completed',
        draft,
        reason: 'none',
      };
    }

    // Check if current picker has autodraft enabled (should pick immediately)
    const draftOrder = await this.draftRepo.getDraftOrder(draftId);
    const currentPicker = draftOrder.find(o => o.rosterId === draft.currentRosterId);
    const isAutodraftEnabled = currentPicker?.isAutodraftEnabled ?? false;

    // Autopick if: deadline expired OR current picker has autodraft enabled
    if (!this.shouldAutoPick(draft) && !isAutodraftEnabled) {
      return {
        actionTaken: false,
        draftCompleted: false,
        draft,
        reason: 'none',
      };
    }

    // Determine reason for autopick
    const deadlineExpired = this.shouldAutoPick(draft);
    const reason = isAutodraftEnabled && !deadlineExpired ? 'autodraft' : 'timeout';

    // Check if pick already exists (race condition: pick was made but draft state not updated)
    const pickAlreadyExists = await this.draftRepo.pickExists(draftId, draft.currentPick);
    if (pickAlreadyExists) {
      // Pick was made but draft state is stale - advance to next pick
      logger.info(`Draft ${draftId}: pick ${draft.currentPick} already exists, recovering stale state`);
      const nextPickInfo = await this.advanceToNextPick(draft, draftOrder);

      // Emit next pick or completion event
      const socket = tryGetSocketService();
      if (socket) {
        if (nextPickInfo) {
          socket.emitNextPick(draftId, nextPickInfo);
        } else {
          const completedDraft = await this.draftRepo.findById(draftId);
          if (completedDraft) {
            socket.emitDraftCompleted(draftId, draftToResponse(completedDraft));
          }
        }
      }

      const updatedDraft = await this.draftRepo.findById(draftId);
      return {
        actionTaken: true,
        draftCompleted: updatedDraft?.status === 'completed',
        draft: updatedDraft!,
        reason,
      };
    }

    // Perform autopick (due to deadline expired or autodraft enabled)
    logger.info(`Draft ${draftId}: performing autopick for roster ${draft.currentRosterId} (reason: ${reason})`);
    const pick = await this.performAutoPick(draft);
    const updatedDraft = await this.draftRepo.findById(draftId);

    // Re-fetch draft order to get the updated state after the pick
    const updatedDraftOrder = await this.draftRepo.getDraftOrder(draftId);
    const nextPicker = updatedDraft?.status === 'in_progress' && updatedDraft.currentRosterId
      ? updatedDraftOrder.find(o => o.rosterId === updatedDraft.currentRosterId)
      : null;

    return {
      actionTaken: true,
      pick,
      draftCompleted: updatedDraft?.status === 'completed',
      draft: updatedDraft!,
      nextPicker,
      reason,
    };
  }

  /**
   * Perform an autopick for the current picker
   */
  protected async performAutoPick(draft: Draft): Promise<DraftPick> {
    if (!draft.currentRosterId) {
      throw new Error('No current roster to pick for');
    }

    const draftOrder = await this.draftRepo.getDraftOrder(draft.id);
    const totalRosters = draftOrder.length;

    // Get the user's queue
    const queue = await this.draftRepo.getQueue(draft.id, draft.currentRosterId);
    const draftedPlayerIds = await this.draftRepo.getDraftedPlayerIds(draft.id);

    let playerId: number | null = null;
    let usedQueue = false;

    // Try to pick from queue first
    for (const queueItem of queue) {
      if (!draftedPlayerIds.has(queueItem.playerId)) {
        playerId = queueItem.playerId;
        usedQueue = true;
        // Remove this player from the user's queue after picking
        await this.draftRepo.removeFromQueue(queueItem.id);
        break;
      } else {
        // Player already drafted - remove from queue
        await this.draftRepo.removeFromQueue(queueItem.id);
      }
    }

    // Fall back to best available if queue exhausted
    if (!playerId) {
      playerId = await this.draftRepo.getBestAvailablePlayer(draft.id);
    }

    if (!playerId) {
      throw new Error(`No available players for auto-pick in draft ${draft.id}`);
    }

    // Create the pick atomically (with advisory lock, recheck, and queue cleanup)
    const pickInRound = this.getPickInRound(draft.currentPick, totalRosters);
    const idempotencyKey = `autopick-${draft.id}-${draft.currentPick}`;
    const pick = await this.draftRepo.createDraftPickWithCleanup(
      draft.id,
      draft.currentPick,
      draft.currentRound,
      pickInRound,
      draft.currentRosterId,
      playerId,
      idempotencyKey
    );

    // Mark as auto-pick (separate from atomic creation)
    await this.draftRepo.markPickAsAutoPick(pick.id);

    // Check if user had autodraft disabled - if so, force-enable it
    const currentPicker = draftOrder.find(o => o.rosterId === draft.currentRosterId);
    if (currentPicker && !currentPicker.isAutodraftEnabled) {
      // Force-enable autodraft since they timed out
      await this.draftRepo.setAutodraftEnabled(draft.id, draft.currentRosterId, true);

      // Emit socket event to notify the user (and others) that autodraft was force-enabled
      const socket = tryGetSocketService();
      socket?.emitAutodraftToggled(draft.id, {
        rosterId: draft.currentRosterId,
        enabled: true,
        forced: true,
      });

      logger.info(
        `Autodraft force-enabled for roster ${draft.currentRosterId} in draft ${draft.id} due to timeout`
      );
    }

    // Queue cleanup is now handled atomically by createDraftPickWithCleanup

    // Advance to next pick
    const nextPickInfo = await this.advanceToNextPick(draft, draftOrder);

    // Emit socket events
    this.emitPickEvents(draft, pick, playerId, nextPickInfo);

    logger.info(
      `Auto-pick made in draft ${draft.id}: player ${playerId} for roster ${draft.currentRosterId}${usedQueue ? ' (from queue)' : ' (best available)'}`
    );

    return pick;
  }

  /**
   * Advance draft to the next pick
   */
  protected async advanceToNextPick(
    draft: Draft,
    draftOrder: DraftOrderEntry[]
  ): Promise<NextPickDetails | null> {
    const totalRosters = draftOrder.length;
    const totalPicks = totalRosters * draft.rounds;
    const nextPick = draft.currentPick + 1;

    if (nextPick > totalPicks) {
      // Draft complete - populate rosters BEFORE marking complete
      await this.populateRostersFromDraft(draft.id, draft.leagueId);

      await this.draftRepo.update(draft.id, {
        status: 'completed',
        completedAt: new Date(),
        currentRosterId: null,
        pickDeadline: null,
      });
      return null;
    }

    const nextRound = this.getRound(nextPick, totalRosters);
    const nextPicker = this.getPickerForPickNumber(draft, draftOrder, nextPick);
    const pickDeadline = this.calculatePickDeadline(draft);

    await this.draftRepo.update(draft.id, {
      currentPick: nextPick,
      currentRound: nextRound,
      currentRosterId: nextPicker?.rosterId || null,
      pickDeadline,
    });

    return {
      currentPick: nextPick,
      currentRound: nextRound,
      currentRosterId: nextPicker?.rosterId || null,
      pickDeadline,
      status: 'in_progress',
    };
  }

  /**
   * Emit socket events for pick
   */
  protected async emitPickEvents(
    draft: Draft,
    pick: DraftPick,
    playerId: number,
    nextPickInfo: NextPickDetails | null
  ): Promise<void> {
    const socket = tryGetSocketService();
    if (!socket) return;

    // Enrich pick with player info for socket
    const player = await this.playerRepo.findById(playerId);
    const enrichedPick = {
      ...pick,
      is_auto_pick: true,
      player_name: player?.fullName,
      player_position: player?.position,
      player_team: player?.team,
    };

    socket.emitDraftPick(draft.id, enrichedPick);

    // Emit queue update event for all users in draft
    socket.emitQueueUpdated(draft.id, {
      playerId,
      action: 'removed',
    });

    if (nextPickInfo) {
      socket.emitNextPick(draft.id, nextPickInfo);
    } else {
      // Draft completed
      const completedDraft = await this.draftRepo.findById(draft.id);
      if (completedDraft) {
        socket.emitDraftCompleted(draft.id, draftToResponse(completedDraft));
      }
    }
  }
}
