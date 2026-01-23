import { IDraftEngine, DraftTickResult, NextPickDetails } from './draft-engine.interface';
import { Draft, DraftOrderEntry, DraftPick, draftToResponse } from '../modules/drafts/drafts.model';
import { DraftRepository, QueueEntry } from '../modules/drafts/drafts.repository';
import { PlayerRepository } from '../modules/players/players.repository';
import { getSocketService } from '../socket';
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
    protected readonly playerRepo: PlayerRepository
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
      pickNumber: nextPickNumber,
      round: nextRound,
      rosterId: nextPicker.rosterId,
      pickDeadline: this.calculatePickDeadline(draft),
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

    if (!this.shouldAutoPick(draft)) {
      return {
        actionTaken: false,
        draftCompleted: false,
        draft,
        reason: 'none',
      };
    }

    // Deadline expired - perform autopick
    const pick = await this.performAutoPick(draft);
    const updatedDraft = await this.draftRepo.findById(draftId);
    const draftOrder = await this.draftRepo.getDraftOrder(draftId);

    const nextPicker = updatedDraft?.status === 'in_progress' && updatedDraft.currentRosterId
      ? draftOrder.find(o => o.rosterId === updatedDraft.currentRosterId)
      : null;

    return {
      actionTaken: true,
      pick,
      draftCompleted: updatedDraft?.status === 'completed',
      draft: updatedDraft!,
      nextPicker,
      reason: 'timeout',
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

    // Create the pick
    const pickInRound = this.getPickInRound(draft.currentPick, totalRosters);
    const pick = await this.draftRepo.createDraftPick(
      draft.id,
      draft.currentPick,
      draft.currentRound,
      pickInRound,
      draft.currentRosterId,
      playerId
    );

    // Mark as auto-pick
    await this.draftRepo.markPickAsAutoPick(pick.id);

    // Remove picked player from ALL queues in this draft
    await this.draftRepo.removePlayerFromAllQueues(draft.id, playerId);

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
      // Draft complete
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
      pickNumber: nextPick,
      round: nextRound,
      rosterId: nextPicker?.rosterId || 0,
      pickDeadline,
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
    try {
      const socket = getSocketService();

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
    } catch {
      // Socket service may not be initialized in tests
    }
  }
}
