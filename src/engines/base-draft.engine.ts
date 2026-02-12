import {
  IDraftEngine,
  DraftTickResult,
  NextPickDetails,
  ActualPickerInfo,
  PickDeadlineContext,
} from './draft-engine.interface';
import type { Draft, DraftOrderEntry, DraftPick, DraftSettings } from '../modules/drafts/drafts.model';
import { draftToResponse } from '../modules/drafts/drafts.model';
import type { DraftRepository } from '../modules/drafts/drafts.repository';
import type { DraftPickAsset } from '../modules/drafts/draft-pick-asset.model';
import type { PlayerRepository } from '../modules/players/players.repository';
import type { RosterPlayersRepository } from '../modules/rosters/rosters.repository';
import type { LeagueRepository, RosterRepository } from '../modules/leagues/leagues.repository';
import { EventTypes, tryGetEventBus } from '../shared/events';
import { logger } from '../config/logger.config';
import { finalizeDraftCompletion } from '../modules/drafts/draft-completion.utils';
import { computeNextPickState as computeNextPickStateShared, NextPickState } from '../modules/drafts/draft-pick-state.utils';
import { container, KEYS } from '../container';
import type { DraftPickAssetRepository } from '../modules/drafts/draft-pick-asset.repository';
import type { VetDraftPickSelectionRepository } from '../modules/drafts/vet-draft-pick-selection.repository';
import { Pool, PoolClient } from 'pg';
import { runInDraftTransaction } from '../shared/locks';

/**
 * Abstract base class for draft engines.
 * Provides shared logic for pick calculation and autopick.
 * Subclasses implement getPickerForPickNumber for draft-type-specific order.
 *
 * LOCK CONTRACT:
 * - tick() acquires DRAFT lock (700M + draftId) via runWithLock for stale-state recovery
 * - performAutoPick() acquires DRAFT lock (700M + draftId) via runInDraftTransaction
 *   All queue reads and pick writes happen atomically inside this transaction
 * - performAutoPickPlayer() / performAutoPickAsset() run inside the caller's DRAFT lock
 *   (either performAutoPick's transaction or engine.tick's recovery path)
 *
 * Only one lock domain (DRAFT) is acquired at a time. No nested cross-domain locks.
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
   * @param draft - The draft object (uses pickTimeSeconds)
   * @param context - Optional context for testing or future pick-specific logic
   */
  calculatePickDeadline(draft: Draft, context?: PickDeadlineContext): Date {
    const now = context?.now ?? new Date();
    const deadline = new Date(now);
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
      // Use runWithLock for proper transaction management
      const pool = container.resolve<Pool>(KEYS.POOL);
      const { runWithLock, LockDomain: RunnerLockDomain } = await import('../shared/transaction-runner');

      const result = await runWithLock(
        pool,
        RunnerLockDomain.DRAFT,
        draftId,
        async (client) => {
          // Re-check under lock using client-aware methods to ensure consistency
          const stillExists = await this.draftRepo.pickExistsWithClient(client, draftId, draft.currentPick);
          const currentDraft = await this.draftRepo.findByIdWithClient(client, draftId);

          if (stillExists && currentDraft && currentDraft.currentPick === draft.currentPick) {
            // Pick was made but draft state is stale - advance to next pick
            logger.info(
              `Draft ${draftId}: pick ${draft.currentPick} already exists, recovering stale state`
            );

            // Re-fetch draftOrder INSIDE the lock for consistency
            const freshDraftOrder = await this.getDraftOrderWithClient(client, draftId);

            // Use client-aware advance method to ensure atomicity
            const nextPickInfo = await this.advanceToNextPickWithClient(client, currentDraft, freshDraftOrder);

            return { advanced: true, nextPickInfo };
          } else {
            // State was already updated by another ticker, nothing to do
            return { advanced: false };
          }
        }
      );

      // Publish domain events AFTER transaction commits
      if (result.advanced) {
        const eventBus = tryGetEventBus();
        if (result.nextPickInfo) {
          eventBus?.publish({
            type: EventTypes.DRAFT_NEXT_PICK,
            payload: {
              draftId,
              ...result.nextPickInfo,
            },
          });
        } else {
          const completedDraft = await this.draftRepo.findById(draftId);
          if (completedDraft) {
            eventBus?.publish({
              type: EventTypes.DRAFT_COMPLETED,
              payload: {
                draftId,
                ...draftToResponse(completedDraft),
              },
            });
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
        const updatedDraft = await this.draftRepo.findById(draftId);
        return {
          actionTaken: false,
          draftCompleted: updatedDraft?.status === 'completed',
          draft: updatedDraft!,
          reason: 'none',
        };
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

    // Wrap all reads and the pick execution in a single draft transaction
    // to prevent race conditions where another process drafts the same player
    // between our queue read and the pick write.
    const pool = container.resolve<Pool>(KEYS.POOL);
    return runInDraftTransaction(pool, draft.id, async (client) => {
      const draftOrder = await this.draftRepo.getDraftOrderWithClient(client, draft.id);
      const settings = draft.settings as DraftSettings;
      const includeRookiePicks = settings?.includeRookiePicks ?? false;

      // Get selected pick asset IDs if this draft includes rookie picks
      let draftedPickAssetIds: Set<number> | undefined;
      if (includeRookiePicks) {
        const vetPickSelectionRepo = container.resolve<VetDraftPickSelectionRepository>(
          KEYS.VET_PICK_SELECTION_REPO
        );
        draftedPickAssetIds = await vetPickSelectionRepo.getSelectedAssetIdsWithClient(client, draft.id);
      }

      // Get the user's queue and drafted player IDs
      const queue = await this.draftRepo.getQueueWithClient(client, draft.id, draft.currentRosterId!);
      const draftedPlayerIds = await this.draftRepo.getDraftedPlayerIdsWithClient(client, draft.id);

      // Find first available queue item (player or pick asset)
      for (const queueItem of queue) {
        if (queueItem.playerId !== null) {
          // Player entry
          if (!draftedPlayerIds.has(queueItem.playerId)) {
            // Found available player - use player pick flow
            // Queue cleanup happens atomically inside makePickAndAdvanceTxWithClient
            return await this.performAutoPickPlayer(draft, draftOrder, queueItem.playerId, true, client);
          }
          // Player already drafted - remove from queue
          await this.draftRepo.removeFromQueueWithClient(client, queueItem.id);
        } else if (queueItem.pickAssetId !== null && includeRookiePicks) {
          // Pick asset entry (only if draft allows)
          if (!draftedPickAssetIds?.has(queueItem.pickAssetId)) {
            // Found available pick asset - use pick asset flow
            // Queue cleanup happens atomically inside makePickAssetSelectionTxWithClient
            return await this.performAutoPickAsset(draft, draftOrder, queueItem.pickAssetId, client);
          }
          // Pick asset already drafted - remove from queue
          await this.draftRepo.removeFromQueueWithClient(client, queueItem.id);
        }
      }

      // Fall back to best available player
      return await this.performAutoPickPlayer(draft, draftOrder, null, false, client);
    });
  }

  /**
   * Perform an autopick for a player.
   * Uses atomic makePickAndAdvanceTx to prevent race conditions.
   */
  protected async performAutoPickPlayer(
    draft: Draft,
    draftOrder: DraftOrderEntry[],
    playerId: number | null,
    usedQueue: boolean,
    client?: PoolClient
  ): Promise<DraftPick> {
    const totalRosters = draftOrder.length;

    // If no playerId, get best available
    if (!playerId) {
      const playerPool = (draft.settings as any)?.playerPool || ['veteran', 'rookie'];
      playerId = client
        ? await this.draftRepo.getBestAvailablePlayerWithClient(client, draft.id, playerPool)
        : await this.draftRepo.getBestAvailablePlayer(draft.id, playerPool);
    }

    if (!playerId) {
      throw new Error(`No available players for auto-pick in draft ${draft.id}`);
    }

    // Load pick assets for computing next pick state
    const pickAssetRepo = container.resolve<DraftPickAssetRepository>(KEYS.PICK_ASSET_REPO);
    const pickAssets = client
      ? await pickAssetRepo.findByDraftIdWithClient(client, draft.id)
      : await pickAssetRepo.findByDraftId(draft.id);

    // Pre-compute next pick state before the atomic transaction
    const nextPickState = this.computeNextPickState(draft, draftOrder, pickAssets);

    // Create the pick AND advance state atomically in a single transaction
    const pickInRound = this.getPickInRound(draft.currentPick, totalRosters);
    const idempotencyKey = `autopick-${draft.id}-${draft.currentPick}`;
    const pickParams = {
      draftId: draft.id,
      expectedPickNumber: draft.currentPick,
      round: draft.currentRound,
      pickInRound,
      rosterId: draft.currentRosterId!,
      playerId,
      nextPickState,
      idempotencyKey,
      isAutoPick: true,
    };
    // Use WithClient variant if a client is provided (caller already holds the lock),
    // otherwise fall back to the standalone transaction variant
    const { pick, draft: updatedDraft } = client
      ? await this.draftRepo.makePickAndAdvanceTxWithClient(client, pickParams)
      : await this.draftRepo.makePickAndAdvanceTx(pickParams);

    // Handle draft completion if this was the last pick
    if (nextPickState.status === 'completed') {
      await finalizeDraftCompletion(
        {
          draftRepo: this.draftRepo,
          leagueRepo: this.leagueRepo,
          rosterPlayersRepo: this.rosterPlayersRepo,
        },
        draft.id,
        draft.leagueId,
        client
      );
    }

    // Check if user had autodraft disabled - if so, force-enable it
    await this.handleAutodraftForceEnable(draft, draftOrder, client);

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
    pickAssetId: number,
    client?: PoolClient
  ): Promise<any> {
    const totalRosters = draftOrder.length;
    const pickInRound = this.getPickInRound(draft.currentPick, totalRosters);

    // Load pick assets for computing next pick state
    const pickAssetRepo = container.resolve<DraftPickAssetRepository>(KEYS.PICK_ASSET_REPO);
    const pickAssets = client
      ? await pickAssetRepo.findByDraftIdWithClient(client, draft.id)
      : await pickAssetRepo.findByDraftId(draft.id);

    // Compute next pick state
    const nextPickState = this.computeNextPickState(draft, draftOrder, pickAssets);

    // Record selection atomically
    const selectionParams = {
      draftId: draft.id,
      expectedPickNumber: draft.currentPick,
      draftPickAssetId: pickAssetId,
      rosterId: draft.currentRosterId!,
      nextPickState,
      idempotencyKey: `autopick-asset-${draft.id}-${draft.currentPick}`,
    };
    // Use WithClient variant if a client is provided (caller already holds the lock),
    // otherwise fall back to the standalone transaction variant
    const result = client
      ? await this.draftRepo.makePickAssetSelectionTxWithClient(client, selectionParams)
      : await this.draftRepo.makePickAssetSelectionTx(selectionParams);

    // Handle draft completion
    if (nextPickState.status === 'completed') {
      await finalizeDraftCompletion(
        {
          draftRepo: this.draftRepo,
          leagueRepo: this.leagueRepo,
          rosterPlayersRepo: this.rosterPlayersRepo,
        },
        draft.id,
        draft.leagueId,
        client
      );
    }

    // Check if user had autodraft disabled - if so, force-enable it
    await this.handleAutodraftForceEnable(draft, draftOrder, client);

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

    // Publish domain events AFTER transaction commits
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.DRAFT_PICK,
      payload: {
        draftId: draft.id,
        ...response,
      },
    });

    if (nextPickState.status !== 'completed') {
      eventBus?.publish({
        type: EventTypes.DRAFT_NEXT_PICK,
        payload: {
          draftId: draft.id,
          currentPick: nextPickState.currentPick,
          currentRound: nextPickState.currentRound,
          currentRosterId: nextPickState.currentRosterId,
          originalRosterId: nextPickState.originalRosterId,
          isTraded: nextPickState.isTraded,
          pickDeadline: nextPickState.pickDeadline,
        },
      });
    } else {
      // Draft completed
      const completedDraft = await this.draftRepo.findById(draft.id);
      if (completedDraft) {
        eventBus?.publish({
          type: EventTypes.DRAFT_COMPLETED,
          payload: {
            draftId: draft.id,
            ...draftToResponse(completedDraft),
          },
        });
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
    draftOrder: DraftOrderEntry[],
    client?: PoolClient
  ): Promise<void> {
    const currentPicker = draftOrder.find((o) => o.rosterId === draft.currentRosterId);
    if (currentPicker && !currentPicker.isAutodraftEnabled) {
      // Force-enable autodraft since they timed out
      if (client) {
        await this.draftRepo.setAutodraftEnabledWithClient(client, draft.id, draft.currentRosterId!, true);
      } else {
        await this.draftRepo.setAutodraftEnabled(draft.id, draft.currentRosterId!, true);
      }

      // Publish domain event to notify the user (and others) that autodraft was force-enabled
      const eventBus = tryGetEventBus();
      eventBus?.publish({
        type: EventTypes.DRAFT_AUTODRAFT_TOGGLED,
        payload: {
          draftId: draft.id,
          rosterId: draft.currentRosterId!,
          enabled: true,
          forced: true,
        },
      });

      logger.info(
        `Autodraft force-enabled for roster ${draft.currentRosterId} in draft ${draft.id} due to timeout`
      );
    }
  }

  /**
   * Pre-compute the next pick state without making any DB changes.
   * Used for pick asset selections where we need to pass the next state to the atomic transaction.
   *
   * Delegates to the shared computeNextPickState utility.
   */
  protected computeNextPickState(
    draft: Draft,
    draftOrder: DraftOrderEntry[],
    pickAssets: DraftPickAsset[] = []
  ): NextPickState {
    return computeNextPickStateShared(draft, draftOrder, this, pickAssets);
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
   * Fetch draft order using an existing DB client (for use within locks).
   */
  protected async getDraftOrderWithClient(client: PoolClient, draftId: number): Promise<DraftOrderEntry[]> {
    const result = await client.query(
      `SELECT do.*, u.username FROM draft_order do
       JOIN rosters r ON do.roster_id = r.id
       LEFT JOIN users u ON r.user_id = u.id
       WHERE do.draft_id = $1 ORDER BY do.draft_position`,
      [draftId]
    );
    return result.rows.map((row: any) => ({
      id: row.id,
      draftId: row.draft_id,
      rosterId: row.roster_id,
      draftPosition: row.draft_position,
      username: row.username,
      isAutodraftEnabled: row.is_autodraft_enabled ?? false,
    }));
  }

  /**
   * Advance draft to the next pick using an existing DB client (for use within locks).
   * This ensures all operations within the stale recovery path are atomic.
   */
  protected async advanceToNextPickWithClient(
    client: PoolClient,
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
        draft.leagueId,
        client
      );

      await client.query(
        `UPDATE drafts SET status = 'completed', completed_at = $1, current_roster_id = NULL,
         pick_deadline = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [new Date(), draft.id]
      );

      return null;
    }

    const nextRound = this.getRound(nextPick, totalRosters);

    // Fetch pick assets to check for traded picks (using client for transaction consistency)
    let nextRosterId: number | null = null;
    try {
      const pickAssetRepo = container.resolve<DraftPickAssetRepository>(KEYS.PICK_ASSET_REPO);
      const pickAssets = await pickAssetRepo.findByDraftIdWithClient(client, draft.id);
      const actualPicker = this.getActualPickerForPickNumber(draft, draftOrder, pickAssets, nextPick);
      nextRosterId = actualPicker?.rosterId || null;
    } catch (error) {
      // Fallback to original picker if pick assets not available
      logger.warn(`Failed to fetch pick assets for draft ${draft.id}, using original picker`, error);
      const originalPicker = this.getPickerForPickNumber(draft, draftOrder, nextPick);
      nextRosterId = originalPicker?.rosterId || null;
    }

    const pickDeadline = this.calculatePickDeadline(draft);

    await client.query(
      `UPDATE drafts SET current_pick = $1, current_round = $2, current_roster_id = $3,
       pick_deadline = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5`,
      [nextPick, nextRound, nextRosterId, pickDeadline, draft.id]
    );

    return {
      currentPick: nextPick,
      currentRound: nextRound,
      currentRosterId: nextRosterId,
      pickDeadline,
      status: 'in_progress',
    };
  }

  /**
   * Publish domain events for pick
   */
  protected async emitPickEvents(
    draft: Draft,
    pick: DraftPick,
    playerId: number,
    nextPickInfo: NextPickDetails | null
  ): Promise<void> {
    const eventBus = tryGetEventBus();

    // Enrich pick with player info for event
    const player = await this.playerRepo.findById(playerId);
    const enrichedPick = {
      ...pick,
      is_auto_pick: true,
      player_name: player?.fullName,
      player_position: player?.position,
      player_team: player?.team,
    };

    eventBus?.publish({
      type: EventTypes.DRAFT_PICK,
      payload: enrichedPick,
    });

    // Publish queue update event for all users in draft
    eventBus?.publish({
      type: EventTypes.DRAFT_QUEUE_UPDATED,
      payload: {
        draftId: draft.id,
        playerId,
        action: 'removed',
      },
    });

    if (nextPickInfo) {
      eventBus?.publish({
        type: EventTypes.DRAFT_NEXT_PICK,
        payload: {
          draftId: draft.id,
          ...nextPickInfo,
        },
      });
    } else {
      // Draft completed
      const completedDraft = await this.draftRepo.findById(draft.id);
      if (completedDraft) {
        eventBus?.publish({
          type: EventTypes.DRAFT_COMPLETED,
          payload: {
            draftId: draft.id,
            ...draftToResponse(completedDraft),
          },
        });
      }
    }
  }
}
