import { Pool, PoolClient } from 'pg';
import { DraftRepository } from './drafts.repository';
import {
  Draft,
  DraftOrderEntry,
  DraftPick,
  DraftSettings,
  DraftResponse,
  DraftResponseWithWarnings,
  draftToResponse,
} from './drafts.model';
import { validatePlayerPoolEligibility } from './draft-validation.utils';
import type { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import type { RosterPlayersRepository } from '../rosters/rosters.repository';
import type { PlayerRepository } from '../players/players.repository';
import type { Player } from '../players/players.model';
import { DraftEngineFactory, IDraftEngine } from '../../engines';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
  ErrorCode,
} from '../../utils/exceptions';
import { EventTypes, tryGetEventBus } from '../../shared/events';
import { finalizeDraftCompletion } from './draft-completion.utils';
import type { ScheduleGeneratorService } from '../matchups/schedule-generator.service';
import { DraftPickAssetRepository } from './draft-pick-asset.repository';
import { DraftPickAsset } from './draft-pick-asset.model';
import {
  computeNextPickState as computeNextPickStateShared,
  NextPickState,
} from './draft-pick-state.utils';
import { DraftChessClockRepository } from './repositories/draft-chess-clock.repository';
import { container, KEYS } from '../../container';
import { runInDraftTransaction } from '../../shared/locks';
import { runWithLock, LockDomain } from '../../shared/transaction-runner';
import { logger } from '../../config/logger.config';

// ============ Parameter Interfaces for Mutation Methods ============

/**
 * Parameters for applyPick - user-initiated player pick
 */
export interface ApplyPickParams {
  leagueId: number;
  draftId: number;
  rosterId: number;
  playerId: number;
  isAutoPick?: boolean;
  idempotencyKey?: string;
}

/**
 * Parameters for applyAutoPick - system auto pick
 */
export interface ApplyAutoPickParams {
  draftId: number;
  reason: 'timeout' | 'autodraft' | 'empty_queue';
}

/**
 * Parameters for advanceTurn - advance to next pick without making a pick
 */
export interface AdvanceTurnParams {
  draftId: number;
}

/**
 * Parameters for applyTimeoutAction - handle pick timeout
 */
export interface ApplyTimeoutActionParams {
  draftId: number;
  forceAutodraft?: boolean;
}

/**
 * Result of applying a pick
 */
export interface ApplyPickResult {
  pick: DraftPick;
  draft: Draft;
  nextPickState: NextPickState;
  player?: Player | null;
}

/**
 * An undone pick asset selection (when a pick asset was drafted instead of a player)
 */
export interface UndonePickAssetSelection {
  id: number;
  pickNumber: number;
  rosterId: number;
  draftPickAssetId: number;
  isPickAsset: true;
}

/** Union type for undone items (either a regular pick or a pick asset selection) */
export type UndoneItem = DraftPick | UndonePickAssetSelection;

// NextPickState is now defined in './draft-pick-state.utils' and imported above.

/**
 * LOCK CONTRACT:
 * - startDraft() uses updateWithLock (conditional SQL update, no advisory lock)
 * - pauseDraft() acquires DRAFT lock (700M + draftId) via runWithLock for fast auctions
 *   (freezes both draft and active lot atomically); non-fast uses conditional SQL update
 * - resumeDraft() acquires DRAFT lock (700M + draftId) via runWithLock for fast auctions
 *   (restores both draft and active lot atomically); non-fast uses conditional SQL update
 * - completeDraft() acquires DRAFT lock (700M + draftId) via runWithLock — atomic status update + finalization
 * - undoPick() acquires DRAFT lock (700M + draftId) via runInDraftTransaction — atomic undo
 * - applyPick() acquires DRAFT lock (700M + draftId) via runInDraftTransaction — atomic pick + state advance
 * - applyAutoPick() acquires DRAFT lock (700M + draftId) via runInDraftTransaction — decision + pick
 * - advanceTurn() acquires DRAFT lock (700M + draftId) via runInDraftTransaction — state advance without pick
 *
 * Only one lock domain (DRAFT) is acquired at a time. No nested cross-domain advisory locks.
 */
export class DraftStateService {
  constructor(
    private readonly db: Pool,
    private readonly draftRepo: DraftRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly engineFactory: DraftEngineFactory,
    private readonly rosterPlayersRepo: RosterPlayersRepository,
    private readonly scheduleGeneratorService?: ScheduleGeneratorService,
    private readonly pickAssetRepo?: DraftPickAssetRepository
  ) {}

  async startDraft(
    draftId: number,
    userId: string,
    idempotencyKey?: string
  ): Promise<DraftResponse> {
    // Idempotency check: return existing result if same key was already used
    const cached = await this.checkIdempotency(idempotencyKey, userId, 'start');
    if (cached) {
      return cached;
    }
    const draft = await this.draftRepo.findById(draftId);
    if (!draft) throw new NotFoundException('Draft not found');

    const isCommissioner = await this.leagueRepo.isCommissioner(draft.leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can start the draft');
    }

    if (draft.status !== 'not_started') {
      // Already started - this is idempotent, return current state
      return draftToResponse(draft);
    }

    // Get first pick's roster
    const draftOrder = await this.draftRepo.getDraftOrder(draftId);
    if (draftOrder.length === 0) {
      throw new ValidationException('Draft order not set');
    }

    // Validate positions are unique and contiguous from 1 to N
    const positions = draftOrder.map((o) => o.draftPosition).sort((a, b) => a - b);
    const expectedPositions = Array.from({ length: draftOrder.length }, (_, i) => i + 1);
    if (positions.join(',') !== expectedPositions.join(',')) {
      throw new ValidationException(
        'Draft order positions must be unique and contiguous from 1 to N'
      );
    }

    // Check auction mode
    const isAuction = draft.draftType === 'auction';
    const isSlowAuction = isAuction && draft.settings?.auctionMode !== 'fast';
    const isFastAuction = isAuction && draft.settings?.auctionMode === 'fast';

    // Ensure commissioner has explicitly confirmed the draft order
    // (not required for auctions since they have their own nomination order)
    if (!draft.orderConfirmed && !isAuction) {
      throw new ValidationException('Draft order must be confirmed before starting');
    }

    let firstPickerRosterId: number | null = null;

    if (!isAuction) {
      // Determine first picker, accounting for traded picks (not applicable for auctions)
      const engine = this.engineFactory.createEngine(draft.draftType);
      if (this.pickAssetRepo) {
        const pickAssets = await this.pickAssetRepo.findByDraftId(draftId);
        const actualPicker = engine.getActualPickerForPickNumber(draft, draftOrder, pickAssets, 1);
        firstPickerRosterId = actualPicker?.rosterId ?? null;
      }
    }

    // Fallback to original logic if no pick assets or no actual picker found
    if (!firstPickerRosterId) {
      const fallbackPicker = draftOrder.find((o) => o.draftPosition === 1);
      firstPickerRosterId = fallbackPicker?.rosterId ?? null;
    }

    const firstPicker =
      draftOrder.find((o) => o.rosterId === firstPickerRosterId) ??
      draftOrder.find((o) => o.draftPosition === 1);

    // Check chess clock mode
    const settings = draft.settings as DraftSettings;
    const isChessClock = !isAuction && settings?.timerMode === 'chess_clock';

    // Set initial pick deadline
    let pickDeadline: Date | null = null;
    const now = new Date();
    if (isFastAuction) {
      // For fast auctions, set nomination deadline using nominationSeconds from settings
      const nominationSeconds = draft.settings?.nominationSeconds ?? 45;
      pickDeadline = new Date(now);
      pickDeadline.setSeconds(pickDeadline.getSeconds() + nominationSeconds);
    } else if (!isSlowAuction) {
      if (isChessClock) {
        // Chess clock mode: first pick deadline = total budget
        const chessClockTotalSeconds = settings.chessClockTotalSeconds ?? 1800;
        pickDeadline = new Date(now.getTime() + chessClockTotalSeconds * 1000);
      } else {
        // For snake/linear drafts, use pickTimeSeconds
        pickDeadline = new Date(now);
        pickDeadline.setSeconds(pickDeadline.getSeconds() + draft.pickTimeSeconds);
      }
    }
    // For slow auctions, no pick deadline (nominations are open to all teams)

    let updatedDraft: Draft;
    let chessClocks: Record<number, number> | undefined;

    if (isChessClock) {
      // Chess clock mode: use transaction to atomically initialize clocks + update draft
      const chessClockRepo = this.getChessClockRepo();
      const chessClockTotalSeconds = settings.chessClockTotalSeconds ?? 1800;
      const rosterIds = draftOrder.map((o) => o.rosterId);

      updatedDraft = await runInDraftTransaction(this.db, draftId, async (client) => {
        // Initialize chess clock entries for all rosters
        await chessClockRepo.initializeWithClient(client, draftId, rosterIds, chessClockTotalSeconds);

        // Update draft state
        return await this.draftRepo.updateWithClient(client, draftId, {
          status: 'in_progress',
          startedAt: now,
          currentPick: 1,
          currentRound: 1,
          currentRosterId: firstPickerRosterId,
          pickDeadline,
          draftState: {
            ...draft.draftState,
            turnStartedAt: now.toISOString(),
          },
        });
      });

      // Build chess clocks map for event payload
      chessClocks = {};
      for (const rosterId of rosterIds) {
        chessClocks[rosterId] = chessClockTotalSeconds;
      }
    } else {
      updatedDraft = await this.draftRepo.updateWithLock(
        draftId,
        {
          status: 'in_progress',
          startedAt: now,
          currentPick: 1,
          currentRound: 1,
          currentRosterId: firstPickerRosterId,
          pickDeadline,
        },
        'not_started'
      );
    }

    const response = draftToResponse(updatedDraft);
    if (chessClocks) {
      response.chess_clocks = chessClocks;
    }

    // Emit events
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.DRAFT_STARTED,
      payload: { draftId, draft: response },
    });
    eventBus?.publish({
      type: EventTypes.DRAFT_NEXT_PICK,
      payload: {
        draftId,
        currentPick: 1,
        currentRound: 1,
        currentRosterId: firstPickerRosterId, // Use traded-pick-aware ID
        pickDeadline,
        status: 'in_progress',
        ...(chessClocks ? { chessClocks } : {}),
      },
    });

    // For fast auctions, also emit nominator changed so frontend shows correct nominator name
    if (isFastAuction && firstPicker) {
      eventBus?.publish({
        type: EventTypes.AUCTION_NOMINATOR_CHANGED,
        payload: {
          draftId,
          nominatorRosterId: firstPicker.rosterId,
          nominationNumber: 1,
          nominationDeadline: pickDeadline?.toISOString(),
        },
      });
    }

    // Store result for idempotency
    await this.saveIdempotencyResult(idempotencyKey, draftId, userId, 'start', response);

    return response;
  }

  async pauseDraft(
    draftId: number,
    userId: string,
    idempotencyKey?: string
  ): Promise<DraftResponse> {
    const cached = await this.checkIdempotency(idempotencyKey, userId, 'pause');
    if (cached) {
      return cached;
    }

    const draft = await this.draftRepo.findById(draftId);
    if (!draft) throw new NotFoundException('Draft not found');

    const isCommissioner = await this.leagueRepo.isCommissioner(draft.leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can pause the draft');
    }

    if (draft.status !== 'in_progress') {
      throw new ValidationException('Can only pause a draft that is in progress');
    }

    // Check auction mode
    const isSlowAuction = draft.draftType === 'auction' && draft.settings?.auctionMode !== 'fast';
    const isFastAuction = draft.draftType === 'auction' && draft.settings?.auctionMode === 'fast';

    if (isFastAuction) {
      // Fast auction: atomically freeze both draft AND active lot bid_deadline
      const response = await runWithLock(this.db, LockDomain.DRAFT, draftId, async (client) => {
        const now = new Date();

        // Calculate remaining nomination timer
        let remainingSeconds: number | null = null;
        remainingSeconds = draft.pickDeadline
          ? Math.max(0, Math.floor((draft.pickDeadline.getTime() - now.getTime()) / 1000))
          : draft.pickTimeSeconds;

        // Find active lot and freeze its bid_deadline
        let pausedLotState: { lotId: number; remainingBidSeconds: number } | null = null;
        const activeLotResult = await client.query(
          `SELECT * FROM auction_lots WHERE draft_id = $1 AND status = 'active' LIMIT 1`,
          [draftId]
        );

        if (activeLotResult.rows.length > 0) {
          const lot = activeLotResult.rows[0];
          const bidDeadline = lot.bid_deadline ? new Date(lot.bid_deadline) : null;
          const remainingBidSeconds = bidDeadline
            ? Math.max(0, Math.floor((bidDeadline.getTime() - now.getTime()) / 1000))
            : 0;

          // Set bid_deadline to NULL so settlement job skips this lot
          await client.query(
            `UPDATE auction_lots SET bid_deadline = NULL WHERE id = $1 AND status = 'active'`,
            [lot.id]
          );

          pausedLotState = { lotId: lot.id, remainingBidSeconds };
        }

        // Update draft status
        const updatedDraft = await this.draftRepo.updateWithClient(client, draftId, {
          status: 'paused',
          pickDeadline: null,
          draftState: {
            ...draft.draftState,
            pausedAt: now.toISOString(),
            pausedBy: userId,
            remainingSeconds,
            pausedLotState,
          },
        });

        return draftToResponse(updatedDraft);
      });

      const eventBus = tryGetEventBus();
      eventBus?.publish({
        type: EventTypes.DRAFT_PAUSED,
        payload: { draftId, draft: response },
      });

      await this.saveIdempotencyResult(idempotencyKey, draftId, userId, 'pause', response);

      return response;
    }

    // Non-fast-auction path (snake, linear, slow auction)
    const now = new Date();
    const isChessClock = this.isChessClockMode(draft);

    if (isChessClock && draft.currentRosterId) {
      // Chess clock pause: deduct elapsed time and use chess clock remaining for pause state
      const chessClockRepo = this.getChessClockRepo();
      const { response: pauseResponse } = await runWithLock(this.db, LockDomain.DRAFT, draftId, async (client) => {
        const freshDraft = await this.draftRepo.findByIdWithClient(client, draftId);
        if (!freshDraft || freshDraft.status !== 'in_progress') {
          throw new ValidationException('Can only pause a draft that is in progress');
        }

        // Deduct elapsed time from current picker's budget
        const { newRemaining } = await this.deductChessClockTime(client, chessClockRepo, freshDraft, now);

        const updatedDraft = await this.draftRepo.updateWithClient(client, draftId, {
          status: 'paused',
          pickDeadline: null,
          draftState: {
            ...freshDraft.draftState,
            pausedAt: now.toISOString(),
            pausedBy: userId,
            remainingSeconds: newRemaining,
            turnStartedAt: null,
          },
        });

        return { response: draftToResponse(updatedDraft) };
      });

      const eventBus = tryGetEventBus();
      eventBus?.publish({
        type: EventTypes.DRAFT_PAUSED,
        payload: { draftId, draft: pauseResponse },
      });

      await this.saveIdempotencyResult(idempotencyKey, draftId, userId, 'pause', pauseResponse);
      return pauseResponse;
    }

    let remainingSeconds: number | null = null;
    if (!isSlowAuction) {
      remainingSeconds = draft.pickDeadline
        ? Math.max(0, Math.floor((draft.pickDeadline.getTime() - now.getTime()) / 1000))
        : draft.pickTimeSeconds;
    }

    const updatedDraft = await this.draftRepo.updateWithLock(
      draftId,
      {
        status: 'paused',
        pickDeadline: null,
        draftState: {
          ...draft.draftState,
          pausedAt: now.toISOString(),
          pausedBy: userId,
          remainingSeconds,
        },
      },
      'in_progress'
    );

    const response = draftToResponse(updatedDraft);

    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.DRAFT_PAUSED,
      payload: { draftId, draft: response },
    });

    await this.saveIdempotencyResult(idempotencyKey, draftId, userId, 'pause', response);

    return response;
  }

  async resumeDraft(
    draftId: number,
    userId: string,
    idempotencyKey?: string
  ): Promise<DraftResponse> {
    const cached = await this.checkIdempotency(idempotencyKey, userId, 'resume');
    if (cached) {
      return cached;
    }

    const draft = await this.draftRepo.findById(draftId);
    if (!draft) throw new NotFoundException('Draft not found');

    const isCommissioner = await this.leagueRepo.isCommissioner(draft.leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can resume the draft');
    }

    if (draft.status !== 'paused') {
      throw new ValidationException('Can only resume a draft that is paused');
    }

    // Check auction mode
    const isSlowAuction = draft.draftType === 'auction' && draft.settings?.auctionMode !== 'fast';
    const isFastAuction = draft.draftType === 'auction' && draft.settings?.auctionMode === 'fast';

    if (isFastAuction) {
      // Fast auction: atomically restore both draft AND active lot bid_deadline
      const { response, restoredLot } = await runWithLock(
        this.db,
        LockDomain.DRAFT,
        draftId,
        async (client) => {
          const now = new Date();
          const remainingSeconds = draft.draftState?.remainingSeconds ?? draft.pickTimeSeconds;
          const pickDeadline = new Date();
          pickDeadline.setSeconds(pickDeadline.getSeconds() + remainingSeconds);

          // Restore active lot bid_deadline from pausedLotState
          const pausedLotState = draft.draftState?.pausedLotState as {
            lotId: number;
            remainingBidSeconds: number;
          } | null;
          let restoredLotData: Record<string, unknown> | null = null;

          if (pausedLotState) {
            const newBidDeadline = new Date();
            newBidDeadline.setSeconds(
              newBidDeadline.getSeconds() + pausedLotState.remainingBidSeconds
            );

            const lotUpdateResult = await client.query(
              `UPDATE auction_lots SET bid_deadline = $1 WHERE id = $2 AND status = 'active' RETURNING *`,
              [newBidDeadline, pausedLotState.lotId]
            );

            if (lotUpdateResult.rows.length > 0) {
              restoredLotData = lotUpdateResult.rows[0];
            }
          }

          // Update draft status
          const updatedDraft = await this.draftRepo.updateWithClient(client, draftId, {
            status: 'in_progress',
            pickDeadline,
            draftState: {
              ...draft.draftState,
              pausedAt: null,
              pausedBy: null,
              remainingSeconds: null,
              pausedLotState: null,
            },
          });

          return {
            response: draftToResponse(updatedDraft),
            restoredLot: restoredLotData,
            pickDeadline,
          };
        }
      );

      const eventBus = tryGetEventBus();
      eventBus?.publish({
        type: EventTypes.DRAFT_RESUMED,
        payload: { draftId, draft: response },
      });

      // Emit lot updated event so clients recalculate countdown
      if (restoredLot) {
        eventBus?.publish({
          type: EventTypes.AUCTION_BID,
          payload: { draftId, lot: restoredLot },
        });
      }

      await this.saveIdempotencyResult(idempotencyKey, draftId, userId, 'resume', response);

      return response;
    }

    // Non-fast-auction path (snake, linear, slow auction)
    const isChessClock = this.isChessClockMode(draft);

    if (isChessClock && draft.currentRosterId) {
      // Chess clock resume: load remaining from chess clock table
      const chessClockRepo = this.getChessClockRepo();
      const { response: resumeResponse, chessClocks, pickDeadline: resumeDeadline } =
        await runWithLock(this.db, LockDomain.DRAFT, draftId, async (client) => {
          const remaining = await chessClockRepo.getRemainingWithClient(
            client, draftId, draft.currentRosterId!
          );
          const settings = draft.settings as DraftSettings;
          const minSeconds = settings.chessClockMinPickSeconds ?? 10;
          const effectiveSeconds = remaining > 0 ? remaining : minSeconds;
          const now = new Date();
          const deadline = new Date(now.getTime() + effectiveSeconds * 1000);

          const updatedDraft = await this.draftRepo.updateWithClient(client, draftId, {
            status: 'in_progress',
            pickDeadline: deadline,
            draftState: {
              ...draft.draftState,
              pausedAt: null,
              pausedBy: null,
              remainingSeconds: null,
              turnStartedAt: now.toISOString(),
            },
          });

          const clocksMap = await chessClockRepo.getClockMapWithClient(client, draftId);
          return {
            response: draftToResponse(updatedDraft),
            chessClocks: clocksMap,
            pickDeadline: deadline,
          };
        });

      const eventBus = tryGetEventBus();
      eventBus?.publish({
        type: EventTypes.DRAFT_RESUMED,
        payload: { draftId, draft: resumeResponse },
      });
      eventBus?.publish({
        type: EventTypes.DRAFT_NEXT_PICK,
        payload: {
          draftId,
          currentPick: draft.currentPick,
          currentRound: draft.currentRound,
          currentRosterId: draft.currentRosterId,
          pickDeadline: resumeDeadline,
          status: 'in_progress',
          chessClocks,
        },
      });

      await this.saveIdempotencyResult(idempotencyKey, draftId, userId, 'resume', resumeResponse);
      return resumeResponse;
    }

    let pickDeadline: Date | null = null;
    if (!isSlowAuction) {
      const remainingSeconds = draft.draftState?.remainingSeconds ?? draft.pickTimeSeconds;
      pickDeadline = new Date();
      pickDeadline.setSeconds(pickDeadline.getSeconds() + remainingSeconds);
    }

    const updatedDraft = await this.draftRepo.updateWithLock(
      draftId,
      {
        status: 'in_progress',
        pickDeadline,
        draftState: {
          ...draft.draftState,
          pausedAt: null,
          pausedBy: null,
          remainingSeconds: null,
        },
      },
      'paused'
    );

    const response = draftToResponse(updatedDraft);

    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.DRAFT_RESUMED,
      payload: { draftId, draft: response },
    });
    eventBus?.publish({
      type: EventTypes.DRAFT_NEXT_PICK,
      payload: {
        draftId,
        currentPick: updatedDraft.currentPick,
        currentRound: updatedDraft.currentRound,
        currentRosterId: updatedDraft.currentRosterId,
        pickDeadline,
        status: 'in_progress',
      },
    });

    await this.saveIdempotencyResult(idempotencyKey, draftId, userId, 'resume', response);

    return response;
  }

  async completeDraft(
    draftId: number,
    userId: string,
    idempotencyKey?: string
  ): Promise<DraftResponseWithWarnings> {
    const cached = await this.checkIdempotency(idempotencyKey, userId, 'complete');
    if (cached) {
      return cached;
    }

    const draft = await this.draftRepo.findById(draftId);
    if (!draft) throw new NotFoundException('Draft not found');

    const isCommissioner = await this.leagueRepo.isCommissioner(draft.leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can complete the draft');
    }

    if (draft.status === 'completed') {
      throw new ValidationException('Draft is already completed');
    }

    if (draft.status === 'not_started') {
      throw new ValidationException('Cannot complete a draft that has not started');
    }

    // Acquire DRAFT advisory lock so that in-flight picks (which also acquire
    // the DRAFT lock via runInDraftTransaction) are blocked while we mark the
    // draft completed and run finalization atomically.
    const { updatedDraft, completionResult } = await runWithLock(
      this.db,
      LockDomain.DRAFT,
      draftId,
      async (client) => {
        // Re-check status inside the lock to prevent TOCTOU race where another
        // process completes the draft between our check above and lock acquisition.
        const freshDraft = await this.draftRepo.findByIdWithClient(client, draftId);
        if (!freshDraft || freshDraft.status === 'completed') {
          throw new ValidationException('Draft is already completed');
        }
        if (freshDraft.status === 'not_started') {
          throw new ValidationException('Cannot complete a draft that has not started');
        }

        // Mark draft as completed FIRST to prevent races with in-flight picks.
        const updated = await this.draftRepo.updateWithClient(client, draftId, {
          status: 'completed',
          completedAt: new Date(),
          pickDeadline: null,
          currentRosterId: null,
        });

        // Run unified finalization (rosters, league status, schedule) inside the lock
        // so no late picks can sneak in between status update and finalization.
        const completion = await finalizeDraftCompletion(
          {
            draftRepo: this.draftRepo,
            leagueRepo: this.leagueRepo,
            rosterPlayersRepo: this.rosterPlayersRepo,
            scheduleGeneratorService: this.scheduleGeneratorService,
          },
          draftId,
          draft.leagueId,
          client
        );

        return { updatedDraft: updated, completionResult: completion };
      }
    );

    const response: DraftResponseWithWarnings = draftToResponse(updatedDraft);

    // Include schedule generation failure info in the response so the
    // commissioner knows manual intervention is needed
    if (completionResult.scheduleGenerationFailed) {
      response.warnings = [
        {
          code: 'SCHEDULE_GENERATION_FAILED',
          message:
            'Draft completed successfully but schedule generation failed. ' +
            'Please generate the schedule manually from league settings.',
          error: completionResult.scheduleError,
        },
      ];
    }

    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.DRAFT_COMPLETED,
      payload: { draftId, draft: response },
    });

    await this.saveIdempotencyResult(idempotencyKey, draftId, userId, 'complete', response);

    return response;
  }

  async deleteDraft(leagueId: number, draftId: number, userId: string): Promise<void> {
    const draft = await this.draftRepo.findById(draftId);
    if (!draft) throw new NotFoundException('Draft not found');

    if (draft.status === 'in_progress') {
      throw new ValidationException('Cannot delete a draft that is in progress');
    }

    if (draft.status === 'completed') {
      throw new ValidationException(
        'Cannot delete a completed draft. Rosters have already been populated.'
      );
    }

    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can delete drafts');
    }

    await this.draftRepo.delete(draftId);
  }

  async undoPick(
    leagueId: number,
    draftId: number,
    userId: string
  ): Promise<{ draft: DraftResponse; undone: UndoneItem }> {
    // Get the pool for running the transaction
    const pool = container.resolve<Pool>(KEYS.POOL);

    // Run all state reads and the undo operation inside a single transaction with lock
    const {
      undoneItem,
      response,
      prevPick,
      prevRound,
      prevPickerRosterId,
      pickDeadline,
      updatedDraftStatus,
      chessClocks,
    } = await runInDraftTransaction(pool, draftId, async (client) => {
      // Read fresh draft state inside lock
      const draft = await this.draftRepo.findByIdWithClient(client, draftId);
      if (!draft) throw new NotFoundException('Draft not found');

      if (draft.leagueId !== leagueId) {
        throw new NotFoundException('Draft not found');
      }

      const isCommissioner = await this.leagueRepo.isCommissioner(draft.leagueId, userId);
      if (!isCommissioner) {
        throw new ForbiddenException('Only the commissioner can undo picks');
      }

      if (draft.status === 'not_started') {
        throw new ValidationException('Cannot undo picks on a draft that has not started');
      }

      const wasCompleted = draft.status === 'completed';

      // Check if this draft has includeRookiePicks enabled
      const settings = draft.settings as DraftSettings;
      const includeRookiePicks = settings?.includeRookiePicks ?? false;

      // Read fresh draft order inside lock
      const draftOrder = await this.draftRepo.getDraftOrderWithClient(client, draftId);
      const engine = this.engineFactory.createEngine(draft.draftType);
      const totalRosters = draftOrder.length;

      // Calculate the previous pick number
      const computedLastPick =
        draft.status === 'completed'
          ? totalRosters * draft.rounds // If completed, last pick was the final one
          : draft.currentPick - 1; // Otherwise, it's one before current
      const computedPrevPick = computedLastPick;
      const computedPrevRound = engine.getRound(computedPrevPick, totalRosters);

      // Fetch pick assets inside lock to account for traded picks
      let computedPrevPickerRosterId: number | null = null;
      try {
        const pickAssetRepo =
          this.pickAssetRepo || container.resolve<DraftPickAssetRepository>(KEYS.PICK_ASSET_REPO);
        const pickAssets = await pickAssetRepo.findByDraftIdWithClient(client, draftId);
        const actualPicker = engine.getActualPickerForPickNumber(
          draft,
          draftOrder,
          pickAssets,
          computedPrevPick
        );
        computedPrevPickerRosterId = actualPicker?.rosterId || null;
      } catch (err) {
        // Fallback to original picker if pick assets not available
        logger.warn(
          'Failed to resolve actual picker via pick assets during undo, falling back to original picker',
          {
            error: err instanceof Error ? err.message : String(err),
            draftId,
            pickNumber: computedPrevPick,
          }
        );
        const prevPicker = engine.getPickerForPickNumber(draft, draftOrder, computedPrevPick);
        computedPrevPickerRosterId = prevPicker?.rosterId || null;
      }

      // Chess clock: restore time for the undone pick
      const isChessClock = this.isChessClockMode(draft);
      let chessClocks: Record<number, number> | undefined;

      // Calculate new deadline only if draft was in progress (not paused)
      const shouldSetDeadline = draft.status === 'in_progress' || wasCompleted;
      let computedPickDeadline: Date | null = null;

      if (isChessClock && shouldSetDeadline && computedPrevPickerRosterId) {
        const chessClockRepo = this.getChessClockRepo();

        // Read the undone pick's time_used_seconds to restore it
        const lastPickResult = await client.query(
          `SELECT time_used_seconds FROM draft_picks
           WHERE draft_id = $1 AND pick_number = $2`,
          [draftId, draft.status === 'completed' ? totalRosters * draft.rounds : draft.currentPick - 1]
        );
        const timeUsed = lastPickResult.rows[0]?.time_used_seconds
          ? parseFloat(lastPickResult.rows[0].time_used_seconds)
          : 0;

        // Restore time to the picker's budget
        if (timeUsed > 0) {
          await chessClockRepo.restoreTimeWithClient(
            client, draftId, computedPrevPickerRosterId, timeUsed
          );
        }

        // Load updated remaining for deadline calculation
        const remaining = await chessClockRepo.getRemainingWithClient(
          client, draftId, computedPrevPickerRosterId
        );
        const minSeconds = settings.chessClockMinPickSeconds ?? 10;
        const effectiveSeconds = remaining > 0 ? remaining : minSeconds;
        computedPickDeadline = new Date(Date.now() + effectiveSeconds * 1000);

        // Load all clocks for event
        chessClocks = await chessClockRepo.getClockMapWithClient(client, draftId);
      } else if (shouldSetDeadline) {
        computedPickDeadline = new Date();
        computedPickDeadline.setSeconds(computedPickDeadline.getSeconds() + draft.pickTimeSeconds);
      }

      // Determine the target status after undo
      const targetStatus = wasCompleted
        ? 'in_progress'
        : (draft.status as 'in_progress' | 'paused');

      // Build draftState updates for chess clock
      const draftStateUpdates = isChessClock && shouldSetDeadline
        ? { ...draft.draftState, turnStartedAt: new Date().toISOString() }
        : undefined;

      // Delete the most recent pick using the client that already holds the lock
      const {
        undonePick,
        undoneSelection,
        draft: updatedDraft,
      } = await this.draftRepo.undoLastPickTxWithClient(client, {
        draftId,
        prevPickState: {
          currentPick: computedPrevPick,
          currentRound: computedPrevRound,
          currentRosterId: computedPrevPickerRosterId,
          pickDeadline: computedPickDeadline,
          status: targetStatus,
          completedAt: null,
        },
        includeRookiePicks,
      });

      if (!undonePick && !undoneSelection) {
        throw new ValidationException('No picks to undo');
      }

      // Update draftState with turnStartedAt for chess clock
      if (draftStateUpdates) {
        await this.draftRepo.updateWithClient(client, draftId, {
          draftState: draftStateUpdates,
        });
      }

      // Build the undone item for socket event
      const computedUndoneItem: UndoneItem = undonePick || {
        id: undoneSelection!.id,
        pickNumber: undoneSelection!.pickNumber,
        rosterId: undoneSelection!.rosterId,
        draftPickAssetId: undoneSelection!.draftPickAssetId,
        isPickAsset: true as const,
      };

      return {
        undoneItem: computedUndoneItem,
        response: draftToResponse(updatedDraft),
        prevPick: computedPrevPick,
        prevRound: computedPrevRound,
        prevPickerRosterId: computedPrevPickerRosterId,
        pickDeadline: computedPickDeadline,
        updatedDraftStatus: updatedDraft.status,
        chessClocks,
      };
    });

    // Emit events AFTER transaction commits
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.DRAFT_PICK_UNDONE,
      payload: { draftId, pick: undoneItem, draft: response },
    });
    if (updatedDraftStatus === 'in_progress') {
      eventBus?.publish({
        type: EventTypes.DRAFT_NEXT_PICK,
        payload: {
          draftId,
          currentPick: prevPick,
          currentRound: prevRound,
          currentRosterId: prevPickerRosterId,
          pickDeadline,
          status: 'in_progress',
          ...(chessClocks ? { chessClocks } : {}),
        },
      });
    }

    return { draft: response, undone: undoneItem };
  }

  // ============ NEW CENTRALIZED MUTATION METHODS ============

  /**
   * Apply a pick to the draft state.
   * This is the SINGLE entry point for all draft picks (manual and auto).
   * All draft state mutations flow through this method.
   */
  async applyPick(params: ApplyPickParams): Promise<ApplyPickResult> {
    const { leagueId, draftId, rosterId, playerId, isAutoPick = false, idempotencyKey } = params;

    const pool = container.resolve<Pool>(KEYS.POOL);
    const playerRepo = container.resolve<PlayerRepository>(KEYS.PLAYER_REPO);

    const { pick, updatedDraft, nextPickState, player, chessClocks } = await runInDraftTransaction(
      pool,
      draftId,
      async (client) => {
        // Read fresh draft state inside lock
        const draft = await this.draftRepo.findByIdWithClient(client, draftId);
        if (!draft) throw new NotFoundException('Draft not found');

        if (draft.leagueId !== leagueId) {
          throw new NotFoundException('Draft not found in this league');
        }

        if (draft.status !== 'in_progress') {
          throw new ValidationException('Draft is not in progress');
        }

        // Validate scheduled start time has passed
        if (draft.scheduledStart && new Date() < draft.scheduledStart) {
          throw new ValidationException('Draft has not started yet', ErrorCode.DRAFT_NOT_STARTED);
        }

        // Validate order is confirmed (non-auction drafts only)
        if (!draft.orderConfirmed && draft.draftType !== 'auction') {
          throw new ValidationException('Draft order must be confirmed before making picks');
        }

        // Validate player pool eligibility
        await validatePlayerPoolEligibility(client, draft, playerId, playerRepo);

        // Read fresh draft order inside lock
        const draftOrder = await this.draftRepo.getDraftOrderWithClient(client, draftId);
        const engine = this.engineFactory.createEngine(draft.draftType);

        // Load pick assets inside lock for fresh traded picks state
        const pickAssets = this.pickAssetRepo
          ? await this.pickAssetRepo.findByDraftIdWithClient(client, draftId)
          : [];

        // Verify it's this roster's turn (skip for auto-picks which are system-initiated)
        if (!isAutoPick) {
          const actualPicker = engine.getActualPickerForPickNumber?.(
            draft,
            draftOrder,
            pickAssets,
            draft.currentPick
          );
          const currentPickerRosterId =
            actualPicker?.rosterId ??
            engine.getPickerForPickNumber(draft, draftOrder, draft.currentPick)?.rosterId;

          if (currentPickerRosterId !== rosterId) {
            throw new ValidationException('It is not your turn to pick');
          }
        }

        // Calculate pick position
        const totalRosters = draftOrder.length;
        const pickInRound = engine.getPickInRound(draft.currentPick, totalRosters);

        // Chess clock: deduct time and compute next state with clock context
        const isChessClock = this.isChessClockMode(draft);
        let timeUsedSeconds: number | undefined;
        let chessClockContext: { remainingSeconds: number } | undefined;
        let clocksMap: Record<number, number> | undefined;

        if (isChessClock) {
          const chessClockRepo = this.getChessClockRepo();
          const now = new Date();

          // Deduct time from current picker
          const { elapsed } = await this.deductChessClockTime(client, chessClockRepo, draft, now);
          timeUsedSeconds = elapsed;

          // Determine next picker's remaining seconds for deadline calculation
          const nextPick = draft.currentPick + 1;
          const totalPicks = totalRosters * draft.rounds;
          if (nextPick <= totalPicks) {
            const actualNextPicker = engine.getActualPickerForPickNumber?.(
              draft, draftOrder, pickAssets, nextPick
            );
            const nextPickerRosterId = actualNextPicker?.rosterId ??
              engine.getPickerForPickNumber(draft, draftOrder, nextPick)?.rosterId;
            if (nextPickerRosterId) {
              const nextRemaining = await chessClockRepo.getRemainingWithClient(
                client, draftId, nextPickerRosterId
              );
              chessClockContext = { remainingSeconds: nextRemaining };
            }
          }

          // Load all clocks for event payload
          clocksMap = await chessClockRepo.getClockMapWithClient(client, draftId);
        }

        // Compute next pick state with FRESH data inside the lock
        const computedNextPickState = this.computeNextPickState(
          draft,
          draftOrder,
          engine,
          pickAssets,
          chessClockContext
        );

        // Make the pick using the client that already holds the lock
        const result = await this.draftRepo.makePickAndAdvanceTxWithClient(client, {
          draftId,
          expectedPickNumber: draft.currentPick,
          round: draft.currentRound,
          pickInRound,
          rosterId,
          playerId,
          nextPickState: computedNextPickState,
          idempotencyKey,
          isAutoPick,
          timeUsedSeconds,
        });

        // Update turnStartedAt for chess clock mode
        if (isChessClock && computedNextPickState.status !== 'completed') {
          await this.draftRepo.updateWithClient(client, draftId, {
            draftState: {
              ...draft.draftState,
              turnStartedAt: new Date().toISOString(),
            },
          });
        }

        // If draft completed, run unified finalization inside the transaction
        if (computedNextPickState.status === 'completed') {
          await finalizeDraftCompletion(
            {
              draftRepo: this.draftRepo,
              leagueRepo: this.leagueRepo,
              rosterPlayersRepo: this.rosterPlayersRepo,
              scheduleGeneratorService: this.scheduleGeneratorService,
            },
            draftId,
            leagueId,
            client
          );
        }

        // Fetch player info for socket event
        const playerData = await playerRepo.findByIdWithClient(client, playerId);

        return {
          pick: result.pick,
          updatedDraft: result.draft,
          nextPickState: computedNextPickState,
          player: playerData,
          chessClocks: clocksMap,
        };
      }
    );

    // Emit events AFTER transaction commits
    this.emitPickEvents(draftId, pick, updatedDraft, nextPickState, player, isAutoPick, chessClocks);

    return { pick, draft: updatedDraft, nextPickState, player };
  }

  /**
   * Apply an automatic pick (timeout, autodraft, or empty queue).
   * Called by autopick job or engine.tick().
   */
  async applyAutoPick(
    params: ApplyAutoPickParams
  ): Promise<ApplyPickResult | { actionTaken: false; reason: string }> {
    const { draftId, reason } = params;

    const pool = container.resolve<Pool>(KEYS.POOL);
    const playerRepo = container.resolve<PlayerRepository>(KEYS.PLAYER_REPO);

    // Combine decision and execution in a single transaction to prevent TOCTOU race
    // where state could change between determining what to pick and applying the pick.
    const result = await runInDraftTransaction(pool, draftId, async (client) => {
      const draft = await this.draftRepo.findByIdWithClient(client, draftId);
      if (!draft) throw new NotFoundException('Draft not found');

      if (draft.status !== 'in_progress') {
        return { actionTaken: false as const, reason: 'not_in_progress' };
      }

      const draftOrder = await this.draftRepo.getDraftOrderWithClient(client, draftId);
      const engine = this.engineFactory.createEngine(draft.draftType);
      const pickAssets = this.pickAssetRepo
        ? await this.pickAssetRepo.findByDraftIdWithClient(client, draftId)
        : [];

      // Determine current picker
      const actualPicker = engine.getActualPickerForPickNumber?.(
        draft,
        draftOrder,
        pickAssets,
        draft.currentPick
      );
      const currentRosterId =
        actualPicker?.rosterId ??
        engine.getPickerForPickNumber(draft, draftOrder, draft.currentPick)?.rosterId;

      if (!currentRosterId) {
        return { actionTaken: false as const, reason: 'no_current_picker' };
      }

      // Get best available player from queue or rankings
      const bestPlayer = await this.getBestAvailablePlayer(
        client,
        draft,
        currentRosterId,
        playerRepo
      );

      if (!bestPlayer) {
        return { actionTaken: false as const, reason: 'no_available_players' };
      }

      // --- Execute the pick within the same transaction ---

      // Validate player pool eligibility
      await validatePlayerPoolEligibility(client, draft, bestPlayer.id, playerRepo);

      // Calculate pick position
      const totalRosters = draftOrder.length;
      const pickInRound = engine.getPickInRound(draft.currentPick, totalRosters);

      // Chess clock: deduct time and compute next state with clock context
      const isChessClock = this.isChessClockMode(draft);
      let timeUsedSeconds: number | undefined;
      let chessClockContext: { remainingSeconds: number } | undefined;
      let clocksMap: Record<number, number> | undefined;

      if (isChessClock) {
        const chessClockRepo = this.getChessClockRepo();
        const now = new Date();
        const { elapsed } = await this.deductChessClockTime(client, chessClockRepo, draft, now);
        timeUsedSeconds = elapsed;

        const nextPick = draft.currentPick + 1;
        const totalPicks = totalRosters * draft.rounds;
        if (nextPick <= totalPicks) {
          const actualNextPicker = engine.getActualPickerForPickNumber?.(
            draft, draftOrder, pickAssets, nextPick
          );
          const nextPickerRosterId = actualNextPicker?.rosterId ??
            engine.getPickerForPickNumber(draft, draftOrder, nextPick)?.rosterId;
          if (nextPickerRosterId) {
            const nextRemaining = await chessClockRepo.getRemainingWithClient(
              client, draftId, nextPickerRosterId
            );
            chessClockContext = { remainingSeconds: nextRemaining };
          }
        }
        clocksMap = await chessClockRepo.getClockMapWithClient(client, draftId);
      }

      // Compute next pick state with fresh data inside the lock
      const computedNextPickState = this.computeNextPickState(
        draft,
        draftOrder,
        engine,
        pickAssets,
        chessClockContext
      );

      const idempotencyKey = `autopick-${draftId}-${draft.currentPick}`;

      // Make the pick using the client that already holds the lock
      const pickResult = await this.draftRepo.makePickAndAdvanceTxWithClient(client, {
        draftId,
        expectedPickNumber: draft.currentPick,
        round: draft.currentRound,
        pickInRound,
        rosterId: currentRosterId,
        playerId: bestPlayer.id,
        nextPickState: computedNextPickState,
        idempotencyKey,
        isAutoPick: true,
        timeUsedSeconds,
      });

      // Update turnStartedAt for chess clock mode
      if (isChessClock && computedNextPickState.status !== 'completed') {
        await this.draftRepo.updateWithClient(client, draftId, {
          draftState: {
            ...draft.draftState,
            turnStartedAt: new Date().toISOString(),
          },
        });
      }

      // If draft completed, run unified finalization inside the transaction
      if (computedNextPickState.status === 'completed') {
        await finalizeDraftCompletion(
          {
            draftRepo: this.draftRepo,
            leagueRepo: this.leagueRepo,
            rosterPlayersRepo: this.rosterPlayersRepo,
            scheduleGeneratorService: this.scheduleGeneratorService,
          },
          draftId,
          draft.leagueId,
          client
        );
      }

      // Fetch player info for socket event
      const player = await playerRepo.findByIdWithClient(client, bestPlayer.id);

      return {
        actionTaken: true as const,
        pick: pickResult.pick,
        updatedDraft: pickResult.draft,
        nextPickState: computedNextPickState,
        player,
        chessClocks: clocksMap,
      };
    });

    if (!result.actionTaken) {
      return result;
    }

    // Emit events AFTER transaction commits
    this.emitPickEvents(
      draftId,
      result.pick,
      result.updatedDraft,
      result.nextPickState,
      result.player,
      true,
      result.chessClocks
    );

    return {
      pick: result.pick,
      draft: result.updatedDraft,
      nextPickState: result.nextPickState,
      player: result.player,
    };
  }

  /**
   * Advance to the next turn without making a pick.
   * Used for recovery scenarios or commissioner skip.
   */
  async advanceTurn(
    params: AdvanceTurnParams
  ): Promise<{ draft: DraftResponse; nextPickState: NextPickState }> {
    const { draftId } = params;
    const pool = container.resolve<Pool>(KEYS.POOL);

    const { response, nextPickState } = await runInDraftTransaction(
      pool,
      draftId,
      async (client) => {
        const draft = await this.draftRepo.findByIdWithClient(client, draftId);
        if (!draft) throw new NotFoundException('Draft not found');

        if (draft.status !== 'in_progress') {
          throw new ValidationException('Draft is not in progress');
        }

        const draftOrder = await this.draftRepo.getDraftOrderWithClient(client, draftId);
        const engine = this.engineFactory.createEngine(draft.draftType);
        const pickAssets = this.pickAssetRepo
          ? await this.pickAssetRepo.findByDraftIdWithClient(client, draftId)
          : [];

        // Compute next state (as if a pick was made)
        const computedNextPickState = this.computeNextPickState(
          draft,
          draftOrder,
          engine,
          pickAssets
        );

        // Update draft state without recording a pick
        const updatedDraft = await this.draftRepo.updateWithClient(client, draftId, {
          currentPick: computedNextPickState.currentPick ?? undefined,
          currentRound: computedNextPickState.currentRound ?? undefined,
          currentRosterId: computedNextPickState.currentRosterId,
          pickDeadline: computedNextPickState.pickDeadline,
          status: computedNextPickState.status,
          completedAt: computedNextPickState.completedAt,
        });

        if (computedNextPickState.status === 'completed') {
          await finalizeDraftCompletion(
            {
              draftRepo: this.draftRepo,
              leagueRepo: this.leagueRepo,
              rosterPlayersRepo: this.rosterPlayersRepo,
              scheduleGeneratorService: this.scheduleGeneratorService,
            },
            draftId,
            draft.leagueId,
            client
          );
        }

        return {
          response: draftToResponse(updatedDraft),
          nextPickState: computedNextPickState,
        };
      }
    );

    // Emit next pick event
    const eventBus = tryGetEventBus();
    if (nextPickState.status !== 'completed') {
      eventBus?.publish({
        type: EventTypes.DRAFT_NEXT_PICK,
        payload: {
          draftId,
          ...nextPickState,
        },
      });
    } else {
      eventBus?.publish({
        type: EventTypes.DRAFT_COMPLETED,
        payload: { draftId, draft: response },
      });
    }

    return { draft: response, nextPickState };
  }

  /**
   * Handle pick timeout - triggers autopick and optionally force-enables autodraft.
   * Called by autopick job when deadline expires.
   */
  async applyTimeoutAction(
    params: ApplyTimeoutActionParams
  ): Promise<ApplyPickResult | { actionTaken: false; reason: string }> {
    const { draftId, forceAutodraft = true } = params;

    // Perform the autopick
    const result = await this.applyAutoPick({ draftId, reason: 'timeout' });

    // If autopick succeeded and forceAutodraft is enabled, enable autodraft for the timed-out user
    if ('pick' in result && forceAutodraft) {
      const rosterId = result.pick.rosterId;
      try {
        await this.draftRepo.setAutodraftEnabled(draftId, rosterId, true);

        const eventBus = tryGetEventBus();
        eventBus?.publish({
          type: EventTypes.DRAFT_AUTODRAFT_TOGGLED,
          payload: {
            draftId,
            rosterId,
            enabled: true,
            forced: true,
          },
        });
      } catch (error) {
        // Log but don't fail the timeout action
        logger.warn(`Failed to enable autodraft for roster ${rosterId}: ${error}`);
      }
    }

    return result;
  }

  // ============ Private Helper Methods ============

  /** Check if a draft uses chess clock timer mode */
  private isChessClockMode(draft: Draft): boolean {
    return (draft.settings as DraftSettings)?.timerMode === 'chess_clock';
  }

  /** Get the chess clock repository from the container */
  private getChessClockRepo(): DraftChessClockRepository {
    return container.resolve<DraftChessClockRepository>(KEYS.CHESS_CLOCK_REPO);
  }

  /**
   * Deduct chess clock time for the current picker.
   * Returns the elapsed seconds that were deducted.
   */
  private async deductChessClockTime(
    client: PoolClient,
    chessClockRepo: DraftChessClockRepository,
    draft: Draft,
    now: Date
  ): Promise<{ elapsed: number; newRemaining: number }> {
    const turnStartedAt = draft.draftState?.turnStartedAt
      ? new Date(draft.draftState.turnStartedAt)
      : (draft.startedAt ?? now);
    const elapsed = Math.max(0, (now.getTime() - turnStartedAt.getTime()) / 1000);
    const newRemaining = await chessClockRepo.deductTimeWithClient(
      client,
      draft.id,
      draft.currentRosterId!,
      elapsed
    );
    return { elapsed, newRemaining };
  }

  /**
   * Compute the next pick state without making any DB changes.
   *
   * Delegates to the shared computeNextPickState utility.
   */
  private computeNextPickState(
    draft: Draft,
    draftOrder: DraftOrderEntry[],
    engine: IDraftEngine,
    pickAssets: DraftPickAsset[] = [],
    chessClockContext?: { remainingSeconds: number }
  ): NextPickState {
    return computeNextPickStateShared(draft, draftOrder, engine, pickAssets, chessClockContext);
  }

  /**
   * Get the best available player for autopick.
   * Uses ADP ranking, respects playerPool filtering, and only considers active players.
   */
  private async getBestAvailablePlayer(
    client: PoolClient,
    draft: Draft,
    rosterId: number,
    playerRepo: PlayerRepository
  ): Promise<Player | null> {
    // First try to get from user's queue
    const queueResult = await client.query(
      `SELECT player_id FROM draft_queues
       WHERE draft_id = $1 AND roster_id = $2
       AND player_id NOT IN (
         SELECT player_id FROM draft_picks WHERE draft_id = $1 AND player_id IS NOT NULL
       )
       ORDER BY queue_position ASC
       LIMIT 1`,
      [draft.id, rosterId]
    );

    if (queueResult.rows.length > 0) {
      return await playerRepo.findByIdWithClient(client, queueResult.rows[0].player_id);
    }

    // Fall back to best available by ADP, respecting playerPool and active status.
    // This mirrors the logic in DraftCoreRepository.getBestAvailablePlayer() to ensure
    // consistent ranking regardless of which autopick code path is triggered.
    const settings = draft.settings as DraftSettings;
    const playerPool = settings?.playerPool || ['veteran', 'rookie'];

    const conditions: string[] = [];
    if (playerPool.includes('veteran')) {
      conditions.push("(player_type = 'nfl' AND (years_exp > 0 OR years_exp IS NULL))");
    }
    if (playerPool.includes('rookie')) {
      conditions.push("(player_type = 'nfl' AND years_exp = 0)");
    }
    if (playerPool.includes('college')) {
      conditions.push("(player_type = 'college')");
    }

    const playerFilter = conditions.length > 0 ? `AND (${conditions.join(' OR ')})` : '';

    const bestAvailableResult = await client.query(
      `SELECT id FROM players
       WHERE active = true
       ${playerFilter}
       AND id NOT IN (
         SELECT player_id FROM draft_picks WHERE draft_id = $1 AND player_id IS NOT NULL
       )
       ORDER BY adp ASC NULLS LAST, id ASC
       LIMIT 1`,
      [draft.id]
    );

    if (bestAvailableResult.rows.length > 0) {
      return await playerRepo.findByIdWithClient(client, bestAvailableResult.rows[0].id);
    }

    return null;
  }

  private async checkIdempotency(
    idempotencyKey: string | undefined,
    userId: string,
    operationType: string
  ): Promise<any | null> {
    if (!idempotencyKey) return null;
    const existing = await this.db.query(
      `SELECT result FROM draft_operations
       WHERE idempotency_key = $1 AND user_id = $2 AND operation_type = $3
       AND expires_at > NOW()`,
      [idempotencyKey, userId, operationType]
    );
    if (existing.rows.length > 0) {
      return existing.rows[0].result;
    }
    return null;
  }

  private async saveIdempotencyResult(
    idempotencyKey: string | undefined,
    draftId: number,
    userId: string,
    operationType: string,
    result: any
  ): Promise<void> {
    if (!idempotencyKey) return;
    await this.db.query(
      `INSERT INTO draft_operations (idempotency_key, draft_id, user_id, operation_type, result)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (idempotency_key, user_id, operation_type) DO NOTHING`,
      [idempotencyKey, draftId, userId, operationType, JSON.stringify(result)]
    );
  }

  /**
   * Emit pick-related events after transaction commits.
   */
  private emitPickEvents(
    draftId: number,
    pick: DraftPick,
    updatedDraft: Draft,
    nextPickState: NextPickState,
    player: Player | null | undefined,
    isAutoPick: boolean,
    chessClocks?: Record<number, number>
  ): void {
    const enrichedPick = {
      ...pick,
      is_auto_pick: isAutoPick,
      player_name: player?.fullName,
      player_position: player?.position,
      player_team: player?.team,
    };

    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.DRAFT_PICK,
      payload: { draftId, pick: enrichedPick },
    });

    eventBus?.publish({
      type: EventTypes.DRAFT_QUEUE_UPDATED,
      payload: { draftId, playerId: pick.playerId, action: 'removed' },
    });

    if (nextPickState.status !== 'completed') {
      eventBus?.publish({
        type: EventTypes.DRAFT_NEXT_PICK,
        payload: {
          draftId,
          currentPick: nextPickState.currentPick,
          currentRound: nextPickState.currentRound,
          currentRosterId: nextPickState.currentRosterId,
          originalRosterId: nextPickState.originalRosterId,
          isTraded: nextPickState.isTraded,
          pickDeadline: nextPickState.pickDeadline,
          ...(chessClocks ? { chessClocks } : {}),
        },
      });
    } else {
      eventBus?.publish({
        type: EventTypes.DRAFT_COMPLETED,
        payload: { draftId, draft: draftToResponse(updatedDraft) },
      });
    }
  }
}
