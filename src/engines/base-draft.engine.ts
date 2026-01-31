import {
  IDraftEngine,
  DraftTickResult,
  NextPickDetails,
  ActualPickerInfo,
} from './draft-engine.interface';
import { Draft, DraftOrderEntry, DraftPick, draftToResponse } from '../modules/drafts/drafts.model';
import { DraftRepository } from '../modules/drafts/drafts.repository';
import { DraftPickAsset } from '../modules/drafts/draft-pick-asset.model';
import { PlayerRepository } from '../modules/players/players.repository';
import { RosterPlayersRepository } from '../modules/rosters/rosters.repository';
import { LeagueRepository, RosterRepository } from '../modules/leagues/leagues.repository';
import { tryGetSocketService } from '../socket';
import { logger } from '../config/env.config';
import { populateRostersFromDraft } from '../modules/drafts/draft-completion.utils';
import { container, KEYS } from '../container';
import { ScheduleGeneratorService } from '../modules/matchups/schedule-generator.service';
import { DraftPickAssetRepository } from '../modules/drafts/draft-pick-asset.repository';

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
    protected readonly leagueRepo: LeagueRepository,
    protected readonly rosterRepo: RosterRepository
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
   * Get the roster that should actually pick at a given pick number,
   * accounting for traded picks.
   *
   * This method checks if the pick has been traded and returns the current owner.
   * If no pick assets are provided or the pick hasn't been traded, it returns
   * the original picker.
   *
   * @param draft - The draft
   * @param draftOrder - The draft order entries
   * @param pickAssets - The draft pick assets (for checking traded picks)
   * @param pickNumber - The pick number to check
   * @returns Info about who actually picks, or undefined if invalid
   */
  getActualPickerForPickNumber(
    draft: Draft,
    draftOrder: DraftOrderEntry[],
    pickAssets: DraftPickAsset[],
    pickNumber: number
  ): ActualPickerInfo | undefined {
    const totalRosters = draftOrder.length;
    const round = this.getRound(pickNumber, totalRosters);

    // Get the original picker based on draft type (snake/linear)
    const originalPicker = this.getPickerForPickNumber(draft, draftOrder, pickNumber);
    if (!originalPicker) {
      return undefined;
    }

    // If no pick assets provided, return original picker
    if (!pickAssets || pickAssets.length === 0) {
      return {
        rosterId: originalPicker.rosterId,
        originalRosterId: originalPicker.rosterId,
        isTraded: false,
      };
    }

    // Find the pick asset for this round + original roster
    const asset = pickAssets.find(
      (a) => a.round === round && a.originalRosterId === originalPicker.rosterId
    );

    if (!asset) {
      // No asset record (shouldn't happen if properly initialized)
      return {
        rosterId: originalPicker.rosterId,
        originalRosterId: originalPicker.rosterId,
        isTraded: false,
      };
    }

    // Return the current owner (may differ from original if traded)
    return {
      rosterId: asset.currentOwnerRosterId,
      originalRosterId: originalPicker.rosterId,
      isTraded: asset.currentOwnerRosterId !== originalPicker.rosterId,
    };
  }

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
  isDraftComplete(_draft: Draft, _afterPickNumber: number): boolean {
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
    const currentPicker = draftOrder.find((o) => o.rosterId === draft.currentRosterId);
    const isAutodraftEnabled = currentPicker?.isAutodraftEnabled ?? false;

    // Check if current roster is empty (no user assigned) - should autopick immediately
    let isEmptyRoster = false;
    if (draft.currentRosterId) {
      const roster = await this.rosterRepo.findById(draft.currentRosterId);
      isEmptyRoster = roster !== null && roster.userId === null;
    }

    // Autopick if: deadline expired OR autodraft enabled OR empty roster
    if (!this.shouldAutoPick(draft) && !isAutodraftEnabled && !isEmptyRoster) {
      return {
        actionTaken: false,
        draftCompleted: false,
        draft,
        reason: 'none',
      };
    }

    // Determine reason for autopick (priority: empty_roster > autodraft > timeout)
    const deadlineExpired = this.shouldAutoPick(draft);
    let reason: 'timeout' | 'autodraft' | 'empty_roster' = 'timeout';
    if (isEmptyRoster) {
      reason = 'empty_roster';
    } else if (isAutodraftEnabled && !deadlineExpired) {
      reason = 'autodraft';
    }

    // Check if pick already exists (race condition: pick was made but draft state not updated)
    const pickAlreadyExists = await this.draftRepo.pickExists(draftId, draft.currentPick);
    if (pickAlreadyExists) {
      // Pick was made but draft state is stale - advance to next pick
      logger.info(
        `Draft ${draftId}: pick ${draft.currentPick} already exists, recovering stale state`
      );
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
    logger.info(
      `Draft ${draftId}: performing autopick for roster ${draft.currentRosterId} (reason: ${reason})`
    );
    const pick = await this.performAutoPick(draft);
    const updatedDraft = await this.draftRepo.findById(draftId);

    // Re-fetch draft order to get the updated state after the pick
    const updatedDraftOrder = await this.draftRepo.getDraftOrder(draftId);
    const nextPicker =
      updatedDraft?.status === 'in_progress' && updatedDraft.currentRosterId
        ? updatedDraftOrder.find((o) => o.rosterId === updatedDraft.currentRosterId)
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
    const currentPicker = draftOrder.find((o) => o.rosterId === draft.currentRosterId);
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
   * Accounts for traded picks by checking pick assets
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
      await populateRostersFromDraft(
        {
          draftRepo: this.draftRepo,
          leagueRepo: this.leagueRepo,
          rosterPlayersRepo: this.rosterPlayersRepo,
        },
        draft.id,
        draft.leagueId
      );

      await this.draftRepo.update(draft.id, {
        status: 'completed',
        completedAt: new Date(),
        currentRosterId: null,
        pickDeadline: null,
      });

      // Update league status to regular_season now that draft is complete
      await this.leagueRepo.update(draft.leagueId, { status: 'regular_season' });

      // Auto-generate season schedule (14 weeks regular season)
      try {
        const scheduleGeneratorService = container.resolve<ScheduleGeneratorService>(
          KEYS.SCHEDULE_GENERATOR_SERVICE
        );
        await scheduleGeneratorService.generateScheduleSystem(draft.leagueId, 14);
        logger.info(`Generated schedule for league ${draft.leagueId} after draft ${draft.id} completion`);
      } catch (error) {
        logger.error('Failed to auto-generate schedule after autopick completion:', error);
      }

      return null;
    }

    const nextRound = this.getRound(nextPick, totalRosters);

    // Fetch pick assets to check for traded picks
    let nextRosterId: number | null = null;
    try {
      const pickAssetRepo = container.resolve<DraftPickAssetRepository>(KEYS.PICK_ASSET_REPO);
      const pickAssets = await pickAssetRepo.findByDraftId(draft.id);
      const actualPicker = this.getActualPickerForPickNumber(draft, draftOrder, pickAssets, nextPick);
      nextRosterId = actualPicker?.rosterId || null;
    } catch (error) {
      // Fallback to original picker if pick assets not available
      logger.warn(`Failed to fetch pick assets for draft ${draft.id}, using original picker`, error);
      const originalPicker = this.getPickerForPickNumber(draft, draftOrder, nextPick);
      nextRosterId = originalPicker?.rosterId || null;
    }

    const pickDeadline = this.calculatePickDeadline(draft);

    await this.draftRepo.update(draft.id, {
      currentPick: nextPick,
      currentRound: nextRound,
      currentRosterId: nextRosterId,
      pickDeadline,
    });

    return {
      currentPick: nextPick,
      currentRound: nextRound,
      currentRosterId: nextRosterId,
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
