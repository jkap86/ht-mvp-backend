import { DraftRepository, QueueEntry } from './drafts.repository';
import { Draft, draftToResponse } from './drafts.model';
import { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import { PlayerRepository } from '../players/players.repository';
import { getSocketService } from '../../socket';
import { getPickerByPosition, calculateRound, calculatePickInRound } from './draft-pick-calculation.helper';
import { logger } from '../../config/env.config';

// Position priority for "best available" fallback
const POSITION_PRIORITY = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

export class DraftAutopickService {
  constructor(
    private readonly draftRepo: DraftRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly playerRepo: PlayerRepository
  ) {}

  /**
   * Process all drafts with expired pick deadlines
   * Called periodically by the cron job
   */
  async processExpiredPicks(): Promise<void> {
    const expiredDrafts = await this.getExpiredDrafts();

    for (const draft of expiredDrafts) {
      try {
        await this.autoPickForDraft(draft);
      } catch (error) {
        logger.error(`Failed to auto-pick for draft ${draft.id}: ${error}`);
      }
    }
  }

  /**
   * Get all drafts with expired pick deadlines
   */
  private async getExpiredDrafts(): Promise<Draft[]> {
    return this.draftRepo.findExpiredDrafts();
  }

  /**
   * Make an auto-pick for the current user in a draft
   */
  async autoPickForDraft(draft: Draft): Promise<void> {
    if (draft.status !== 'in_progress' || !draft.currentRosterId) {
      return;
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
      playerId = await this.getBestAvailable(draft.id, draftedPlayerIds);
    }

    if (!playerId) {
      logger.warn(`No available players for auto-pick in draft ${draft.id}`);
      return;
    }

    // Create the pick
    const pickInRound = calculatePickInRound(draft.currentPick, totalRosters);
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

    logger.info(`Auto-pick made in draft ${draft.id}: player ${playerId} for roster ${draft.currentRosterId}${usedQueue ? ' (from queue)' : ' (best available)'}`);
  }

  /**
   * Get the best available player (not yet drafted)
   * Uses position priority as a simple ranking
   */
  private async getBestAvailable(draftId: number, _draftedPlayerIds: Set<number>): Promise<number | null> {
    return this.draftRepo.getBestAvailablePlayer(draftId);
  }

  /**
   * Advance to the next pick after an auto-pick
   */
  private async advanceToNextPick(draft: Draft, draftOrder: any[]): Promise<any | null> {
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

    const nextRound = calculateRound(nextPick, totalRosters);
    const nextPicker = getPickerByPosition(nextRound, nextPick, draft.draftType, draftOrder);

    const pickDeadline = new Date();
    pickDeadline.setSeconds(pickDeadline.getSeconds() + draft.pickTimeSeconds);

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
    };
  }
}
