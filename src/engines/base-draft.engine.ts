import {
  IDraftEngine,
  DraftTickResult,
  NextPickDetails,
  ActualPickerInfo,
} from './draft-engine.interface';
import { Draft, DraftOrderEntry, DraftPick, DraftSettings, draftToResponse } from '../modules/drafts/drafts.model';
import { DraftRepository } from '../modules/drafts/drafts.repository';
import { DraftPickAsset } from '../modules/drafts/draft-pick-asset.model';
import { PlayerRepository } from '../modules/players/players.repository';
import { RosterPlayersRepository } from '../modules/rosters/rosters.repository';
import { LeagueRepository, RosterRepository } from '../modules/leagues/leagues.repository';
import { tryGetSocketService } from '../socket';
import { logger } from '../config/env.config';
import { finalizeDraftCompletion } from '../modules/drafts/draft-completion.utils';
import { container, KEYS } from '../container';
import { DraftPickAssetRepository } from '../modules/drafts/draft-pick-asset.repository';
import { VetDraftPickSelectionRepository } from '../modules/drafts/vet-draft-pick-selection.repository';
import { getLockId, LockDomain } from '../shared/locks';
import { Pool } from 'pg';

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
      throw new Error(`Draft not found: ${draftId}`);
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
      // Acquire lock before advancing to prevent race with other tickers
      const pool = container.resolve<Pool>(KEYS.POOL);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [getLockId(LockDomain.DRAFT, draftId)]);

        // Re-check under lock using client-aware methods to ensure consistency
        const stillExists = await this.draftRepo.pickExistsWithClient(client, draftId, draft.currentPick);
        const currentDraft = await this.draftRepo.findByIdWithClient(client, draftId);

        if (stillExists && currentDraft && currentDraft.currentPick === draft.currentPick) {
          // Pick was made but draft state is stale - advance to next pick
          logger.info(
            `Draft ${draftId}: pick ${draft.currentPick} already exists, recovering stale state`
          );
          const nextPickInfo = await this.advanceToNextPick(currentDraft, draftOrder);

          await client.query('COMMIT');

          // Emit next pick or completion event (after commit)
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
        } else {
          // State was already updated by another ticker, nothing to do
          await client.query('COMMIT');
          const updatedDraft = await this.draftRepo.findById(draftId);
          return {
            actionTaken: false,
            draftCompleted: updatedDraft?.status === 'completed',
            draft: updatedDraft!,
            reason: 'none',
          };
        }
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
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
   * Perform an autopick for the current picker.
   * Supports both player picks and pick asset selections (for vet drafts with includeRookiePicks).
   */
  protected async performAutoPick(draft: Draft): Promise<DraftPick | any> {
    if (!draft.currentRosterId) {
      throw new Error('No current roster to pick for');
    }

    const draftOrder = await this.draftRepo.getDraftOrder(draft.id);
    const settings = draft.settings as DraftSettings;
    const includeRookiePicks = settings?.includeRookiePicks ?? false;

    // Get selected pick asset IDs if this draft includes rookie picks
    let draftedPickAssetIds: Set<number> | undefined;
    if (includeRookiePicks) {
      const vetPickSelectionRepo = container.resolve<VetDraftPickSelectionRepository>(
        KEYS.VET_PICK_SELECTION_REPO
      );
      draftedPickAssetIds = await vetPickSelectionRepo.getSelectedAssetIds(draft.id);
    }

    // Get the user's queue and drafted player IDs
    const queue = await this.draftRepo.getQueue(draft.id, draft.currentRosterId);
    const draftedPlayerIds = await this.draftRepo.getDraftedPlayerIds(draft.id);

    // Find first available queue item (player or pick asset)
    for (const queueItem of queue) {
      if (queueItem.playerId !== null) {
        // Player entry
        if (!draftedPlayerIds.has(queueItem.playerId)) {
          // Found available player - use player pick flow
          await this.draftRepo.removeFromQueue(queueItem.id);
          return await this.performAutoPickPlayer(draft, draftOrder, queueItem.playerId, true);
        }
        // Player already drafted - remove from queue
        await this.draftRepo.removeFromQueue(queueItem.id);
      } else if (queueItem.pickAssetId !== null && includeRookiePicks) {
        // Pick asset entry (only if draft allows)
        if (!draftedPickAssetIds?.has(queueItem.pickAssetId)) {
          // Found available pick asset - use pick asset flow
          await this.draftRepo.removeFromQueue(queueItem.id);
          return await this.performAutoPickAsset(draft, draftOrder, queueItem.pickAssetId);
        }
        // Pick asset already drafted - remove from queue
        await this.draftRepo.removeFromQueue(queueItem.id);
      }
    }

    // Fall back to best available player
    return await this.performAutoPickPlayer(draft, draftOrder, null, false);
  }

  /**
   * Perform an autopick for a player.
   * Uses atomic makePickAndAdvanceTx to prevent race conditions.
   */
  protected async performAutoPickPlayer(
    draft: Draft,
    draftOrder: DraftOrderEntry[],
    playerId: number | null,
    usedQueue: boolean
  ): Promise<DraftPick> {
    const totalRosters = draftOrder.length;

    // If no playerId, get best available
    if (!playerId) {
      const playerPool = (draft.settings as any)?.playerPool || ['veteran', 'rookie'];
      playerId = await this.draftRepo.getBestAvailablePlayer(draft.id, playerPool);
    }

    if (!playerId) {
      throw new Error(`No available players for auto-pick in draft ${draft.id}`);
    }

    // Load pick assets for computing next pick state
    const pickAssetRepo = container.resolve<DraftPickAssetRepository>(KEYS.PICK_ASSET_REPO);
    const pickAssets = await pickAssetRepo.findByDraftId(draft.id);

    // Pre-compute next pick state before the atomic transaction
    const nextPickState = this.computeNextPickState(draft, draftOrder, pickAssets);

    // Create the pick AND advance state atomically in a single transaction
    const pickInRound = this.getPickInRound(draft.currentPick, totalRosters);
    const idempotencyKey = `autopick-${draft.id}-${draft.currentPick}`;
    const { pick, draft: updatedDraft } = await this.draftRepo.makePickAndAdvanceTx({
      draftId: draft.id,
      expectedPickNumber: draft.currentPick,
      round: draft.currentRound,
      pickInRound,
      rosterId: draft.currentRosterId!,
      playerId,
      nextPickState,
      idempotencyKey,
      isAutoPick: true,
    });

    // Handle draft completion if this was the last pick
    if (nextPickState.status === 'completed') {
      await finalizeDraftCompletion(
        {
          draftRepo: this.draftRepo,
          leagueRepo: this.leagueRepo,
          rosterPlayersRepo: this.rosterPlayersRepo,
        },
        draft.id,
        draft.leagueId
      );
    }

    // Check if user had autodraft disabled - if so, force-enable it
    await this.handleAutodraftForceEnable(draft, draftOrder);

    // Build next pick info for socket emission
    // When status is 'in_progress', pickDeadline is always set by computeNextPickState
    const nextPickInfo: NextPickDetails | null = nextPickState.status === 'completed' ? null : {
      currentPick: nextPickState.currentPick!,
      currentRound: nextPickState.currentRound!,
      currentRosterId: nextPickState.currentRosterId,
      pickDeadline: nextPickState.pickDeadline!,
      status: 'in_progress',
    };

    // Emit socket events AFTER transaction has committed
    this.emitPickEvents(draft, pick, playerId, nextPickInfo);

    logger.info(
      `Auto-pick made in draft ${draft.id}: player ${playerId} for roster ${draft.currentRosterId}${usedQueue ? ' (from queue)' : ' (best available)'}`
    );

    return pick;
  }

  /**
   * Perform an autopick for a pick asset (rookie draft pick).
   * Used in vet drafts with includeRookiePicks enabled.
   */
  protected async performAutoPickAsset(
    draft: Draft,
    draftOrder: DraftOrderEntry[],
    pickAssetId: number
  ): Promise<any> {
    const totalRosters = draftOrder.length;
    const pickInRound = this.getPickInRound(draft.currentPick, totalRosters);

    // Load pick assets for computing next pick state
    const pickAssetRepo = container.resolve<DraftPickAssetRepository>(KEYS.PICK_ASSET_REPO);
    const pickAssets = await pickAssetRepo.findByDraftId(draft.id);

    // Compute next pick state
    const nextPickState = this.computeNextPickState(draft, draftOrder, pickAssets);

    // Record selection atomically
    const result = await this.draftRepo.makePickAssetSelectionTx({
      draftId: draft.id,
      expectedPickNumber: draft.currentPick,
      draftPickAssetId: pickAssetId,
      rosterId: draft.currentRosterId!,
      nextPickState,
      idempotencyKey: `autopick-asset-${draft.id}-${draft.currentPick}`,
    });

    // Handle draft completion
    if (nextPickState.status === 'completed') {
      await finalizeDraftCompletion(
        {
          draftRepo: this.draftRepo,
          leagueRepo: this.leagueRepo,
          rosterPlayersRepo: this.rosterPlayersRepo,
        },
        draft.id,
        draft.leagueId
      );
    }

    // Check if user had autodraft disabled - if so, force-enable it
    await this.handleAutodraftForceEnable(draft, draftOrder);

    // Get pick asset details for socket event
    const pickAsset = await pickAssetRepo.findByIdWithDetails(pickAssetId);

    // Build response with pick asset info
    const response = {
      id: result.selectionId,
      draft_id: draft.id,
      pick_number: draft.currentPick,
      round: draft.currentRound,
      pick_in_round: pickInRound,
      roster_id: draft.currentRosterId,
      player_id: null,
      is_auto_pick: true,
      picked_at: result.selectedAt,
      // Pick asset specific fields
      draft_pick_asset_id: pickAssetId,
      pick_asset_season: pickAsset?.season,
      pick_asset_round: pickAsset?.round,
      pick_asset_original_team: pickAsset?.originalTeamName,
      is_pick_asset: true,
    };

    // Emit socket events AFTER transaction commits
    const socket = tryGetSocketService();
    socket?.emitDraftPick(draft.id, response);

    if (nextPickState.status !== 'completed') {
      socket?.emitNextPick(draft.id, {
        currentPick: nextPickState.currentPick,
        currentRound: nextPickState.currentRound,
        currentRosterId: nextPickState.currentRosterId,
        originalRosterId: nextPickState.originalRosterId,
        isTraded: nextPickState.isTraded,
        pickDeadline: nextPickState.pickDeadline,
      });
    } else {
      // Draft completed
      const completedDraft = await this.draftRepo.findById(draft.id);
      if (completedDraft) {
        socket?.emitDraftCompleted(draft.id, draftToResponse(completedDraft));
      }
    }

    logger.info(
      `Auto-pick made in draft ${draft.id}: pick asset ${pickAssetId} for roster ${draft.currentRosterId} (from queue)`
    );

    return response;
  }

  /**
   * Force-enable autodraft if user timed out with it disabled.
   */
  protected async handleAutodraftForceEnable(
    draft: Draft,
    draftOrder: DraftOrderEntry[]
  ): Promise<void> {
    const currentPicker = draftOrder.find((o) => o.rosterId === draft.currentRosterId);
    if (currentPicker && !currentPicker.isAutodraftEnabled) {
      // Force-enable autodraft since they timed out
      await this.draftRepo.setAutodraftEnabled(draft.id, draft.currentRosterId!, true);

      // Emit socket event to notify the user (and others) that autodraft was force-enabled
      const socket = tryGetSocketService();
      socket?.emitAutodraftToggled(draft.id, {
        rosterId: draft.currentRosterId!,
        enabled: true,
        forced: true,
      });

      logger.info(
        `Autodraft force-enabled for roster ${draft.currentRosterId} in draft ${draft.id} due to timeout`
      );
    }
  }

  /**
   * Pre-compute the next pick state without making any DB changes.
   * Used for pick asset selections where we need to pass the next state to the atomic transaction.
   */
  protected computeNextPickState(
    draft: Draft,
    draftOrder: DraftOrderEntry[],
    pickAssets: DraftPickAsset[] = []
  ): {
    currentPick: number | null;
    currentRound: number | null;
    currentRosterId: number | null;
    originalRosterId: number | null;
    isTraded: boolean;
    pickDeadline: Date | null;
    status?: 'in_progress' | 'completed';
    completedAt?: Date | null;
  } {
    const totalRosters = draftOrder.length;
    const totalPicks = totalRosters * draft.rounds;
    const nextPick = draft.currentPick + 1;

    if (nextPick > totalPicks) {
      // Draft complete
      return {
        currentPick: null,
        currentRound: null,
        currentRosterId: null,
        originalRosterId: null,
        isTraded: false,
        pickDeadline: null,
        status: 'completed',
        completedAt: new Date(),
      };
    }

    const nextRound = this.getRound(nextPick, totalRosters);

    // Use getActualPickerForPickNumber to account for traded picks
    const actualPicker = this.getActualPickerForPickNumber(draft, draftOrder, pickAssets, nextPick);

    // Fall back to original picker logic if traded picks not calculated
    const originalPicker = this.getPickerForPickNumber(draft, draftOrder, nextPick);
    const nextPickerRosterId = actualPicker?.rosterId ?? originalPicker?.rosterId ?? null;

    const pickDeadline = this.calculatePickDeadline(draft);

    return {
      currentPick: nextPick,
      currentRound: nextRound,
      currentRosterId: nextPickerRosterId,
      originalRosterId: actualPicker?.originalRosterId ?? originalPicker?.rosterId ?? null,
      isTraded: actualPicker?.isTraded ?? false,
      pickDeadline,
      status: 'in_progress',
    };
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
      // Draft complete - run unified finalization (rosters, league status, schedule)
      await finalizeDraftCompletion(
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
