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
import type { DraftPickAsset, DraftPickAssetWithDetails } from '../modules/drafts/draft-pick-asset.model';
import type { Player } from '../modules/players/players.model';
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
import { isInPauseWindow } from '../shared/utils/time-utils';
import type { DraftChessClockRepository } from '../modules/drafts/repositories/draft-chess-clock.repository';

/**
 * Data collected inside the transaction for post-commit event emission.
 * Follows the pattern from DraftStateService.applyPick: collect data inside txn, emit after commit.
 */
interface AutoPickEventData {
  type: 'player' | 'asset';
  draftId: number;
  /** For player picks: the enriched pick payload */
  pickPayload?: Record<string, any>;
  /** For asset picks: the response object */
  assetResponse?: Record<string, any>;
  /** Player ID (for queue update event) */
  playerId?: number;
  /** Pick asset ID (for queue update event on asset picks) */
  pickAssetId?: number;
  /** Next pick info (null if draft completed) */
  nextPickInfo?: NextPickDetails | null;
  /** Next pick state (for asset picks with richer data) */
  nextPickState?: NextPickState;
  /** Completed draft response data (pre-collected inside txn) */
  completedDraftResponse?: Record<string, any>;
  /** Chess clock data for event payload (only in chess clock mode) */
  chessClocks?: Record<number, number>;
}

/**
 * Result from performAutoPickInternal, containing both the pick/response
 * and the event data to emit after the transaction commits.
 */
interface AutoPickInternalResult {
  /** The pick (for player picks) or response (for asset picks) */
  result: any;
  /** Data needed for post-commit event emission */
  eventData: AutoPickEventData;
}

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
   * Check if draft is currently in overnight pause window.
   * Only applies to snake/linear drafts with overnight pause enabled.
   *
   * @param draft - The draft to check
   * @returns true if draft is in overnight pause window
   */
  protected isInOvernightPause(draft: Draft): boolean {
    // Only apply to snake/linear drafts (not auction)
    if (draft.draftType === 'auction') {
      return false;
    }

    // Check if overnight pause is enabled
    if (!draft.overnightPauseEnabled || !draft.overnightPauseStart || !draft.overnightPauseEnd) {
      return false;
    }

    // Check if current time is in pause window
    return isInPauseWindow(new Date(), draft.overnightPauseStart, draft.overnightPauseEnd);
  }

  /**
   * Calculate next pick deadline
   * @param draft - The draft object (uses pickTimeSeconds)
   * @param context - Optional context for testing or future pick-specific logic
   */
  calculatePickDeadline(draft: Draft, context?: PickDeadlineContext): Date {
    const now = context?.now ?? new Date();
    const settings = draft.settings as DraftSettings;

    if (settings.timerMode === 'chess_clock' && context?.chessClockRemainingSeconds !== undefined) {
      const minSeconds = settings.chessClockMinPickSeconds ?? 10;
      const budget = context.chessClockRemainingSeconds;
      const effectiveSeconds = budget > 0 ? budget : minSeconds;
      return new Date(now.getTime() + effectiveSeconds * 1000);
    }

    // Default: per-pick mode (unchanged)
    const deadline = new Date(now);
    deadline.setSeconds(deadline.getSeconds() + draft.pickTimeSeconds);
    return deadline;
  }

  /**
   * Process a tick - check for expired picks and autopick if needed
   */
  async tick(draftId: number): Promise<DraftTickResult> {
    // Initial lightweight check (outside lock) - allows early exit for completed/non-existent drafts
    const draftSnapshot = await this.draftRepo.findById(draftId);

    if (!draftSnapshot) {
      throw new Error(`Draft not found: ${draftId}`);
    }

    if (draftSnapshot.status !== 'in_progress') {
      return {
        actionTaken: false,
        draftCompleted: draftSnapshot.status === 'completed',
        draft: draftSnapshot,
        reason: 'none',
      };
    }

    // Acquire lock and read fresh state to prevent race conditions
    const pool = container.resolve<Pool>(KEYS.POOL);
    const { runWithLock, LockDomain: RunnerLockDomain } = await import('../shared/transaction-runner');

    type TickInternalResult = {
      actionTaken: boolean;
      reason: 'timeout' | 'autodraft' | 'empty_roster' | 'none';
      pick?: DraftPick;
      advanced?: boolean;
      nextPickInfo?: NextPickDetails;
      /** Event data from autopick, to be emitted after transaction commits */
      autoPickEventData?: AutoPickEventData;
    };

    const result = await runWithLock<TickInternalResult>(
      pool,
      RunnerLockDomain.DRAFT,
      draftId,
      async (client) => {
        // Read FRESH draft state INSIDE the lock
        const draft = await this.draftRepo.findByIdWithClient(client, draftId);

        if (!draft) {
          throw new Error(`Draft not found: ${draftId}`);
        }

        // Double-check status under lock (could have changed)
        if (draft.status !== 'in_progress') {
          return {
            actionTaken: false,
            reason: 'none' as const,
          };
        }

        // Check if draft is in overnight pause window
        if (this.isInOvernightPause(draft)) {
          logger.debug(`Draft ${draftId}: skipping tick - in overnight pause window`);
          return {
            actionTaken: false,
            reason: 'none' as const,
          };
        }

        // Read draft order with fresh state
        const draftOrder = await this.getDraftOrderWithClient(client, draftId);
        const currentPicker = draftOrder.find((o) => o.rosterId === draft.currentRosterId);
        const isAutodraftEnabled = currentPicker?.isAutodraftEnabled ?? false;

        // Check if current roster is empty (no user assigned) - should autopick immediately
        let isEmptyRoster = false;
        if (draft.currentRosterId) {
          const roster = await this.rosterRepo.findByIdWithClient(client, draft.currentRosterId);
          isEmptyRoster = roster !== null && roster.userId === null;
        }

        // Autopick if: deadline expired OR autodraft enabled OR empty roster
        if (!this.shouldAutoPick(draft) && !isAutodraftEnabled && !isEmptyRoster) {
          return {
            actionTaken: false,
            reason: 'none' as const,
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

        // Check if pick already exists (race condition recovery: pick was made but draft state not updated)
        const pickAlreadyExists = await this.draftRepo.pickExistsWithClient(client, draftId, draft.currentPick);
        if (pickAlreadyExists) {
          // Pick was made but draft state is stale - advance to next pick
          logger.info(
            `Draft ${draftId}: pick ${draft.currentPick} already exists, recovering stale state`
          );

          // Use client-aware advance method to ensure atomicity
          const nextPickInfo = await this.advanceToNextPickWithClient(client, draft, draftOrder);

          return {
            actionTaken: true,
            reason,
            advanced: true,
            nextPickInfo: nextPickInfo ?? undefined,
          };
        }

        // Perform autopick with fresh state (due to deadline expired or autodraft enabled)
        logger.info(
          `Draft ${draftId}: performing autopick for roster ${draft.currentRosterId} (reason: ${reason})`
        );

        // Call performAutoPickInternal which expects to run within an existing transaction
        // Event data is collected inside and returned for post-commit emission
        const autoPickResult = await this.performAutoPickInternal(client, draft, draftOrder);

        return {
          actionTaken: true,
          reason,
          pick: autoPickResult.result,
          advanced: false,
          autoPickEventData: autoPickResult.eventData,
        };
      }
    );

    // Publish domain events AFTER transaction commits
    const eventBus = tryGetEventBus();
    if (result.actionTaken && result.advanced && result.nextPickInfo) {
      // State recovery case - publish next pick event
      eventBus?.publish({
        type: EventTypes.DRAFT_NEXT_PICK,
        payload: {
          draftId,
          ...result.nextPickInfo,
        },
      });
    }
    // Emit autopick events AFTER transaction commits (data was collected inside txn)
    if (result.autoPickEventData) {
      this.emitAutoPickEvents(result.autoPickEventData);
    }

    // Re-fetch final state outside lock for return value
    const finalDraft = await this.draftRepo.findById(draftId);
    const updatedDraftOrder = await this.draftRepo.getDraftOrder(draftId);
    const nextPicker =
      finalDraft?.status === 'in_progress' && finalDraft.currentRosterId
        ? updatedDraftOrder.find((o) => o.rosterId === finalDraft.currentRosterId)
        : null;

    return {
      actionTaken: result.actionTaken,
      pick: result.pick,
      draftCompleted: finalDraft?.status === 'completed',
      draft: finalDraft!,
      nextPicker: result.actionTaken ? nextPicker : undefined,
      reason: result.reason,
    };
  }

  /**
   * Perform an autopick for the current picker.
   * Supports both player picks and pick asset selections (for vet drafts with includeRookiePicks).
   *
   * This is the public API that acquires its own lock.
   * Events are emitted AFTER the transaction commits.
   */
  protected async performAutoPick(draft: Draft): Promise<DraftPick | any> {
    if (!draft.currentRosterId) {
      throw new Error('No current roster to pick for');
    }

    // Wrap all reads and the pick execution in a single draft transaction
    // to prevent race conditions where another process drafts the same player
    // between our queue read and the pick write.
    const pool = container.resolve<Pool>(KEYS.POOL);
    const { result, eventData } = await runInDraftTransaction(pool, draft.id, async (client) => {
      const draftOrder = await this.draftRepo.getDraftOrderWithClient(client, draft.id);
      return this.performAutoPickInternal(client, draft, draftOrder);
    });

    // Emit events AFTER transaction commits
    this.emitAutoPickEvents(eventData);

    return result;
  }

  /**
   * Internal autopick implementation that runs within an existing transaction/lock.
   * Used by both performAutoPick (which acquires its own lock) and tick() (which already has a lock).
   *
   * Returns both the pick result and the event data needed for post-commit emission.
   * Callers are responsible for emitting events AFTER the transaction commits.
   */
  protected async performAutoPickInternal(
    client: PoolClient,
    draft: Draft,
    draftOrder: DraftOrderEntry[]
  ): Promise<AutoPickInternalResult> {
    if (!draft.currentRosterId) {
      throw new Error('No current roster to pick for');
    }

    const settings = draft.settings as DraftSettings;
    const includeRookiePicks = settings?.includeRookiePicks ?? false;

    // Chess clock: deduct time before autopick
    const isChessClock = settings?.timerMode === 'chess_clock';
    let timeUsedSeconds: number | undefined;
    let chessClockContext: { remainingSeconds: number } | undefined;
    let chessClocks: Record<number, number> | undefined;

    if (isChessClock) {
      const chessClockRepo = container.resolve<DraftChessClockRepository>(KEYS.CHESS_CLOCK_REPO);
      const now = new Date();
      const turnStartedAt = draft.draftState?.turnStartedAt
        ? new Date(draft.draftState.turnStartedAt)
        : (draft.startedAt ?? now);
      const elapsed = Math.max(0, (now.getTime() - turnStartedAt.getTime()) / 1000);
      await chessClockRepo.deductTimeWithClient(client, draft.id, draft.currentRosterId, elapsed);
      timeUsedSeconds = elapsed;

      // Determine next picker's remaining seconds
      const totalRosters = draftOrder.length;
      const nextPick = draft.currentPick + 1;
      const totalPicks = totalRosters * draft.rounds;
      if (nextPick <= totalPicks) {
        const pickAssetRepo = container.resolve<DraftPickAssetRepository>(KEYS.PICK_ASSET_REPO);
        const pickAssets = await pickAssetRepo.findByDraftIdWithClient(client, draft.id);
        const actualNextPicker = this.getActualPickerForPickNumber(
          draft, draftOrder, pickAssets, nextPick
        );
        const nextPickerRosterId = actualNextPicker?.rosterId ??
          this.getPickerForPickNumber(draft, draftOrder, nextPick)?.rosterId;
        if (nextPickerRosterId) {
          const nextRemaining = await chessClockRepo.getRemainingWithClient(
            client, draft.id, nextPickerRosterId
          );
          chessClockContext = { remainingSeconds: nextRemaining };
        }
      }
      chessClocks = await chessClockRepo.getClockMapWithClient(client, draft.id);
    }

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
          const result = await this.performAutoPickPlayer(draft, draftOrder, queueItem.playerId, true, client, chessClockContext, timeUsedSeconds);
          if (chessClocks) result.eventData.chessClocks = chessClocks;
          return result;
        }
        // Player already drafted - remove from queue
        await this.draftRepo.removeFromQueueWithClient(client, queueItem.id);
      } else if (queueItem.pickAssetId !== null && includeRookiePicks) {
        // Pick asset entry (only if draft allows)
        if (!draftedPickAssetIds?.has(queueItem.pickAssetId)) {
          // Found available pick asset - use pick asset flow
          // Queue cleanup happens atomically inside makePickAssetSelectionTxWithClient
          const result = await this.performAutoPickAsset(draft, draftOrder, queueItem.pickAssetId, client, chessClockContext, timeUsedSeconds);
          if (chessClocks) result.eventData.chessClocks = chessClocks;
          return result;
        }
        // Pick asset already drafted - remove from queue
        await this.draftRepo.removeFromQueueWithClient(client, queueItem.id);
      }
    }

    // Fall back to best available player
    let fallbackResult: AutoPickInternalResult | null = null;
    try {
      fallbackResult = await this.performAutoPickPlayer(draft, draftOrder, null, false, client, chessClockContext, timeUsedSeconds);
    } catch (_playerError) {
      // No available players - try pick assets if enabled
      fallbackResult = null;
    }

    // If no player available and includeRookiePicks is enabled, try best available pick asset
    if (!fallbackResult && includeRookiePicks) {
      const settings = draft.settings as DraftSettings;
      const pickAssetRepo = container.resolve<DraftPickAssetRepository>(KEYS.PICK_ASSET_REPO);
      const availableAssets = await pickAssetRepo.getAvailablePickAssetsForVetDraftWithClient(
        client,
        draft.leagueId,
        draft.id,
        settings.rookiePicksSeason!,
        settings.rookiePicksRounds
      );

      if (availableAssets.length > 0) {
        fallbackResult = await this.performAutoPickAsset(draft, draftOrder, availableAssets[0].id, client, chessClockContext, timeUsedSeconds);
      }
    }

    if (!fallbackResult) {
      throw new Error(`No available players or pick assets for auto-pick in draft ${draft.id}`);
    }

    if (chessClocks) fallbackResult.eventData.chessClocks = chessClocks;

    // Update turnStartedAt for chess clock mode after autopick
    if (isChessClock) {
      await this.draftRepo.updateWithClient(client, draft.id, {
        draftState: {
          ...draft.draftState,
          turnStartedAt: new Date().toISOString(),
        },
      });
    }

    return fallbackResult;
  }

  /**
   * Perform an autopick for a player.
   * Uses atomic makePickAndAdvanceTx to prevent race conditions.
   *
   * Collects all data needed for event emission inside the transaction.
   * Returns the pick AND event data; callers emit events AFTER transaction commits.
   */
  protected async performAutoPickPlayer(
    draft: Draft,
    draftOrder: DraftOrderEntry[],
    playerId: number | null,
    usedQueue: boolean,
    client?: PoolClient,
    chessClockContext?: { remainingSeconds: number },
    timeUsedSeconds?: number
  ): Promise<AutoPickInternalResult> {
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
    const nextPickState = this.computeNextPickState(draft, draftOrder, pickAssets, chessClockContext);

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
      timeUsedSeconds,
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

    // Collect player info INSIDE the transaction using the transaction client
    // This ensures we read committed data consistent with the transaction
    const player: Player | null = client
      ? await this.playerRepo.findByIdWithClient(client, playerId)
      : await this.playerRepo.findById(playerId);

    // Collect completed draft data inside the transaction if draft completed
    let completedDraftResponse: Record<string, any> | undefined;
    if (nextPickState.status === 'completed') {
      const completedDraft = client
        ? await this.draftRepo.findByIdWithClient(client, draft.id)
        : await this.draftRepo.findById(draft.id);
      if (completedDraft) {
        completedDraftResponse = draftToResponse(completedDraft);
      }
    }

    // Build the enriched pick payload for the event (collected inside txn)
    const pickPayload = {
      ...pick,
      is_auto_pick: true,
      player_name: player?.fullName,
      player_position: player?.position,
      player_team: player?.team,
    };

    logger.info(
      `Auto-pick made in draft ${draft.id}: player ${playerId} for roster ${draft.currentRosterId}${usedQueue ? ' (from queue)' : ' (best available)'}`
    );

    return {
      result: pick,
      eventData: {
        type: 'player',
        draftId: draft.id,
        pickPayload,
        playerId,
        nextPickInfo,
        completedDraftResponse,
      },
    };
  }

  /**
   * Perform an autopick for a pick asset (rookie draft pick).
   * Used in vet drafts with includeRookiePicks enabled.
   *
   * Collects all data needed for event emission inside the transaction.
   * Returns the response AND event data; callers emit events AFTER transaction commits.
   */
  protected async performAutoPickAsset(
    draft: Draft,
    draftOrder: DraftOrderEntry[],
    pickAssetId: number,
    client?: PoolClient,
    chessClockContext?: { remainingSeconds: number },
    timeUsedSeconds?: number
  ): Promise<AutoPickInternalResult> {
    const totalRosters = draftOrder.length;
    const pickInRound = this.getPickInRound(draft.currentPick, totalRosters);

    // Load pick assets for computing next pick state (uses client for transaction consistency)
    const pickAssetRepo = container.resolve<DraftPickAssetRepository>(KEYS.PICK_ASSET_REPO);
    const pickAssets: DraftPickAssetWithDetails[] = client
      ? await pickAssetRepo.findByDraftIdWithClient(client, draft.id)
      : await pickAssetRepo.findByDraftId(draft.id);

    // Compute next pick state
    const nextPickState = this.computeNextPickState(draft, draftOrder, pickAssets, chessClockContext);

    // Record selection atomically
    const selectionParams = {
      draftId: draft.id,
      expectedPickNumber: draft.currentPick,
      draftPickAssetId: pickAssetId,
      rosterId: draft.currentRosterId!,
      nextPickState,
      idempotencyKey: `autopick-asset-${draft.id}-${draft.currentPick}`,
      isAutoPick: true,
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

    // Get pick asset details from the already-loaded pickAssets array (read with client)
    // instead of making a separate pool read via findByIdWithDetails
    const pickAsset = pickAssets.find((a) => a.id === pickAssetId);

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

    // Collect completed draft data inside the transaction if draft completed
    let completedDraftResponse: Record<string, any> | undefined;
    if (nextPickState.status === 'completed') {
      const completedDraft = client
        ? await this.draftRepo.findByIdWithClient(client, draft.id)
        : await this.draftRepo.findById(draft.id);
      if (completedDraft) {
        completedDraftResponse = draftToResponse(completedDraft);
      }
    }

    logger.info(
      `Auto-pick made in draft ${draft.id}: pick asset ${pickAssetId} for roster ${draft.currentRosterId} (from queue)`
    );

    return {
      result: response,
      eventData: {
        type: 'asset',
        draftId: draft.id,
        assetResponse: response,
        pickAssetId: pickAssetId,
        nextPickState,
        completedDraftResponse,
      },
    };
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
    pickAssets: DraftPickAsset[] = [],
    chessClockContext?: { remainingSeconds: number }
  ): NextPickState {
    return computeNextPickStateShared(draft, draftOrder, this, pickAssets, chessClockContext);
  }

  /**
   * Advance draft to the next pick
   * Accounts for traded picks by checking pick assets
   */
  protected async advanceToNextPick(
    draft: Draft,
    draftOrder: DraftOrderEntry[]
  ): Promise<NextPickDetails | null> {
    // Wrap in a DRAFT advisory lock + transaction so that finalizeDraftCompletion
    // and the subsequent draftRepo update are atomic. Without this, a failure
    // between the two operations would leave draft state inconsistent.
    const pool = container.resolve<Pool>(KEYS.POOL);

    return runInDraftTransaction(pool, draft.id, async (client) => {
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

        await this.draftRepo.updateWithClient(client, draft.id, {
          status: 'completed',
          completedAt: new Date(),
          currentRosterId: null,
          pickDeadline: null,
        });

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

      await this.draftRepo.updateWithClient(client, draft.id, {
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
        status: 'in_progress' as const,
      };
    });
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
   * Emit autopick events using pre-collected data.
   * Called AFTER the transaction commits to ensure clients see committed state.
   *
   * All data needed for events was collected inside the transaction using the
   * transaction client, following the pattern from DraftStateService.applyPick.
   */
  protected emitAutoPickEvents(eventData: AutoPickEventData): void {
    const eventBus = tryGetEventBus();

    if (eventData.type === 'player') {
      // Player pick events
      eventBus?.publish({
        type: EventTypes.DRAFT_PICK,
        payload: eventData.pickPayload!,
      });

      // Publish queue update event for all users in draft
      eventBus?.publish({
        type: EventTypes.DRAFT_QUEUE_UPDATED,
        payload: {
          draftId: eventData.draftId,
          playerId: eventData.playerId,
          action: 'removed',
        },
      });

      if (eventData.nextPickInfo) {
        eventBus?.publish({
          type: EventTypes.DRAFT_NEXT_PICK,
          payload: {
            draftId: eventData.draftId,
            ...eventData.nextPickInfo,
            ...(eventData.chessClocks ? { chessClocks: eventData.chessClocks } : {}),
          },
        });
      } else if (eventData.completedDraftResponse) {
        eventBus?.publish({
          type: EventTypes.DRAFT_COMPLETED,
          payload: {
            draftId: eventData.draftId,
            ...eventData.completedDraftResponse,
          },
        });
      }
    } else {
      // Asset pick events
      eventBus?.publish({
        type: EventTypes.DRAFT_PICK,
        payload: {
          draftId: eventData.draftId,
          ...eventData.assetResponse!,
        },
      });

      // Publish queue update event for pick asset removal
      if (eventData.pickAssetId) {
        eventBus?.publish({
          type: EventTypes.DRAFT_QUEUE_UPDATED,
          payload: {
            draftId: eventData.draftId,
            pickAssetId: eventData.pickAssetId,
            action: 'removed',
          },
        });
      }

      const nextPickState = eventData.nextPickState!;
      if (nextPickState.status !== 'completed') {
        eventBus?.publish({
          type: EventTypes.DRAFT_NEXT_PICK,
          payload: {
            draftId: eventData.draftId,
            currentPick: nextPickState.currentPick,
            currentRound: nextPickState.currentRound,
            currentRosterId: nextPickState.currentRosterId,
            originalRosterId: nextPickState.originalRosterId,
            isTraded: nextPickState.isTraded,
            pickDeadline: nextPickState.pickDeadline,
            ...(eventData.chessClocks ? { chessClocks: eventData.chessClocks } : {}),
          },
        });
      } else if (eventData.completedDraftResponse) {
        eventBus?.publish({
          type: EventTypes.DRAFT_COMPLETED,
          payload: {
            draftId: eventData.draftId,
            ...eventData.completedDraftResponse,
          },
        });
      }
    }
  }
}
