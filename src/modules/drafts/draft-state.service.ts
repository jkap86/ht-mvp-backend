import { Pool, PoolClient } from 'pg';
import { DraftRepository } from './drafts.repository';
import { Draft, DraftOrderEntry, DraftSettings, draftToResponse } from './drafts.model';
import { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import { RosterPlayersRepository } from '../rosters/rosters.repository';
import { PlayerRepository } from '../players/players.repository';
import { Player } from '../players/players.model';
import { DraftEngineFactory, IDraftEngine } from '../../engines';
import { NotFoundException, ForbiddenException, ValidationException, ErrorCode } from '../../utils/exceptions';
import { EventTypes, tryGetEventBus } from '../../shared/events';
import { finalizeDraftCompletion } from './draft-completion.utils';
import { ScheduleGeneratorService } from '../matchups/schedule-generator.service';
import { DraftPickAssetRepository } from './draft-pick-asset.repository';
import { DraftPickAsset } from './draft-pick-asset.model';
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
  pick: any;
  draft: any;
  nextPickState: NextPickState;
  player?: Player | null;
}

/**
 * Next pick state computed after a pick
 */
export interface NextPickState {
  currentPick: number | null;
  currentRound: number | null;
  currentRosterId: number | null;
  originalRosterId?: number | null;
  isTraded?: boolean;
  pickDeadline: Date | null;
  status?: 'in_progress' | 'completed';
  completedAt?: Date | null;
}

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

  async startDraft(draftId: number, userId: string, idempotencyKey?: string): Promise<any> {
    // Idempotency check: return existing result if same key was already used
    if (idempotencyKey) {
      const existing = await this.db.query(
        `SELECT result FROM draft_operations
         WHERE idempotency_key = $1 AND user_id = $2 AND operation_type = 'start'
         AND expires_at > NOW()`,
        [idempotencyKey, userId]
      );
      if (existing.rows.length > 0) {
        return existing.rows[0].result;
      }
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

    const firstPicker = draftOrder.find((o) => o.rosterId === firstPickerRosterId) ??
      draftOrder.find((o) => o.draftPosition === 1);

    // Set initial pick deadline
    let pickDeadline: Date | null = null;
    if (isFastAuction) {
      // For fast auctions, set nomination deadline using nominationSeconds from settings
      const nominationSeconds = draft.settings?.nominationSeconds ?? 45;
      pickDeadline = new Date();
      pickDeadline.setSeconds(pickDeadline.getSeconds() + nominationSeconds);
    } else if (!isSlowAuction) {
      // For snake/linear drafts, use pickTimeSeconds
      pickDeadline = new Date();
      pickDeadline.setSeconds(pickDeadline.getSeconds() + draft.pickTimeSeconds);
    }
    // For slow auctions, no pick deadline (nominations are open to all teams)

    const updatedDraft = await this.draftRepo.updateWithLock(
      draftId,
      {
        status: 'in_progress',
        startedAt: new Date(),
        currentPick: 1,
        currentRound: 1,
        currentRosterId: firstPickerRosterId,
        pickDeadline,
      },
      'not_started'
    );

    const response = draftToResponse(updatedDraft);

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
        currentRosterId: firstPickerRosterId,  // Use traded-pick-aware ID
        pickDeadline,
        status: 'in_progress',
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
    if (idempotencyKey) {
      await this.db.query(
        `INSERT INTO draft_operations (idempotency_key, draft_id, user_id, operation_type, result)
         VALUES ($1, $2, $3, 'start', $4)
         ON CONFLICT (idempotency_key, user_id, operation_type) DO NOTHING`,
        [idempotencyKey, draftId, userId, JSON.stringify(response)]
      );
    }

    return response;
  }

  async pauseDraft(draftId: number, userId: string): Promise<any> {
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

      return response;
    }

    // Non-fast-auction path (snake, linear, slow auction)
    const now = new Date();
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

    return response;
  }

  async resumeDraft(draftId: number, userId: string): Promise<any> {
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
      const { response, restoredLot } = await runWithLock(this.db, LockDomain.DRAFT, draftId, async (client) => {
        const now = new Date();
        const remainingSeconds = draft.draftState?.remainingSeconds ?? draft.pickTimeSeconds;
        const pickDeadline = new Date();
        pickDeadline.setSeconds(pickDeadline.getSeconds() + remainingSeconds);

        // Restore active lot bid_deadline from pausedLotState
        const pausedLotState = draft.draftState?.pausedLotState as { lotId: number; remainingBidSeconds: number } | null;
        let restoredLotData: any = null;

        if (pausedLotState) {
          const newBidDeadline = new Date();
          newBidDeadline.setSeconds(newBidDeadline.getSeconds() + pausedLotState.remainingBidSeconds);

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

        return { response: draftToResponse(updatedDraft), restoredLot: restoredLotData, pickDeadline };
      });

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

      return response;
    }

    // Non-fast-auction path (snake, linear, slow auction)
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

    return response;
  }

  async completeDraft(draftId: number, userId: string): Promise<any> {
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

    // Run unified finalization (rosters, league status, schedule)
    await finalizeDraftCompletion(
      {
        draftRepo: this.draftRepo,
        leagueRepo: this.leagueRepo,
        rosterPlayersRepo: this.rosterPlayersRepo,
        scheduleGeneratorService: this.scheduleGeneratorService,
      },
      draftId,
      draft.leagueId
    );

    // Use updateWithLock to ensure atomic update and prevent races with in-flight picks
    const updatedDraft = await this.draftRepo.updateWithLock(draftId, {
      status: 'completed',
      completedAt: new Date(),
      pickDeadline: null,
      currentRosterId: null,
    });

    const response = draftToResponse(updatedDraft);

    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.DRAFT_COMPLETED,
      payload: { draftId, draft: response },
    });

    return response;
  }

  async deleteDraft(leagueId: number, draftId: number, userId: string): Promise<void> {
    const draft = await this.draftRepo.findById(draftId);
    if (!draft) throw new NotFoundException('Draft not found');

    if (draft.status === 'in_progress') {
      throw new ValidationException('Cannot delete a draft that is in progress');
    }

    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can delete drafts');
    }

    await this.draftRepo.delete(draftId);
  }

  async undoPick(draftId: number, userId: string): Promise<{ draft: any; undone: any }> {
    // Get the pool for running the transaction
    const pool = container.resolve<Pool>(KEYS.POOL);

    // Run all state reads and the undo operation inside a single transaction with lock
    const { undoneItem, response, prevPick, prevRound, prevPickerRosterId, pickDeadline, updatedDraftStatus } =
      await runInDraftTransaction(pool, draftId, async (client) => {
        // Read fresh draft state inside lock
        const draft = await this.draftRepo.findByIdWithClient(client, draftId);
        if (!draft) throw new NotFoundException('Draft not found');

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
        const computedLastPick = draft.status === 'completed'
          ? totalRosters * draft.rounds  // If completed, last pick was the final one
          : draft.currentPick - 1;       // Otherwise, it's one before current
        const computedPrevPick = computedLastPick;
        const computedPrevRound = engine.getRound(computedPrevPick, totalRosters);

        // Fetch pick assets inside lock to account for traded picks
        let computedPrevPickerRosterId: number | null = null;
        try {
          const pickAssetRepo = this.pickAssetRepo || container.resolve<DraftPickAssetRepository>(KEYS.PICK_ASSET_REPO);
          const pickAssets = await pickAssetRepo.findByDraftIdWithClient(client, draftId);
          const actualPicker = engine.getActualPickerForPickNumber(draft, draftOrder, pickAssets, computedPrevPick);
          computedPrevPickerRosterId = actualPicker?.rosterId || null;
        } catch {
          // Fallback to original picker if pick assets not available
          const prevPicker = engine.getPickerForPickNumber(draft, draftOrder, computedPrevPick);
          computedPrevPickerRosterId = prevPicker?.rosterId || null;
        }

        // Calculate new deadline only if draft was in progress (not paused)
        const shouldSetDeadline = draft.status === 'in_progress' || wasCompleted;
        let computedPickDeadline: Date | null = null;
        if (shouldSetDeadline) {
          computedPickDeadline = new Date();
          computedPickDeadline.setSeconds(computedPickDeadline.getSeconds() + draft.pickTimeSeconds);
        }

        // Determine the target status after undo
        const targetStatus = wasCompleted ? 'in_progress' : (draft.status as 'in_progress' | 'paused');

        // Delete the most recent pick using the client that already holds the lock
        const { undonePick, undoneSelection, draft: updatedDraft } =
          await this.draftRepo.undoLastPickTxWithClient(client, {
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

        // Build the undone item for socket event
        const computedUndoneItem = undonePick || {
          id: undoneSelection!.id,
          pickNumber: undoneSelection!.pickNumber,
          rosterId: undoneSelection!.rosterId,
          draftPickAssetId: undoneSelection!.draftPickAssetId,
          isPickAsset: true,
        };

        return {
          undoneItem: computedUndoneItem,
          response: draftToResponse(updatedDraft),
          prevPick: computedPrevPick,
          prevRound: computedPrevRound,
          prevPickerRosterId: computedPrevPickerRosterId,
          pickDeadline: computedPickDeadline,
          updatedDraftStatus: updatedDraft.status,
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

    const { pick, updatedDraft, nextPickState, player } = await runInDraftTransaction(
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
        await this.validatePlayerPoolEligibility(client, draft, playerId, playerRepo);

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

        // Compute next pick state with FRESH data inside the lock
        const computedNextPickState = this.computeNextPickState(draft, draftOrder, engine, pickAssets);

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
        });

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
            leagueId
          );
        }

        // Fetch player info for socket event
        const playerData = await playerRepo.findByIdWithClient(client, playerId);

        return {
          pick: result.pick,
          updatedDraft: result.draft,
          nextPickState: computedNextPickState,
          player: playerData,
        };
      }
    );

    // Emit events AFTER transaction commits
    this.emitPickEvents(draftId, pick, updatedDraft, nextPickState, player, isAutoPick);

    return { pick, draft: updatedDraft, nextPickState, player };
  }

  /**
   * Apply an automatic pick (timeout, autodraft, or empty queue).
   * Called by autopick job or engine.tick().
   */
  async applyAutoPick(params: ApplyAutoPickParams): Promise<ApplyPickResult | { actionTaken: false; reason: string }> {
    const { draftId, reason } = params;

    const pool = container.resolve<Pool>(KEYS.POOL);

    // First, determine what to pick
    const pickDecision = await runInDraftTransaction(pool, draftId, async (client) => {
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
      const playerRepo = container.resolve<PlayerRepository>(KEYS.PLAYER_REPO);
      const bestPlayer = await this.getBestAvailablePlayer(client, draft, currentRosterId, playerRepo);

      if (!bestPlayer) {
        return { actionTaken: false as const, reason: 'no_available_players' };
      }

      return {
        actionTaken: true as const,
        leagueId: draft.leagueId,
        rosterId: currentRosterId,
        playerId: bestPlayer.id,
      };
    });

    if (!pickDecision.actionTaken) {
      return pickDecision;
    }

    // Now apply the pick
    return await this.applyPick({
      leagueId: pickDecision.leagueId,
      draftId,
      rosterId: pickDecision.rosterId,
      playerId: pickDecision.playerId,
      isAutoPick: true,
      idempotencyKey: `autopick-${draftId}-${Date.now()}`,
    });
  }

  /**
   * Advance to the next turn without making a pick.
   * Used for recovery scenarios or commissioner skip.
   */
  async advanceTurn(params: AdvanceTurnParams): Promise<{ draft: any; nextPickState: NextPickState }> {
    const { draftId } = params;
    const pool = container.resolve<Pool>(KEYS.POOL);

    const { response, nextPickState } = await runInDraftTransaction(pool, draftId, async (client) => {
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
      const computedNextPickState = this.computeNextPickState(draft, draftOrder, engine, pickAssets);

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
          draft.leagueId
        );
      }

      return {
        response: draftToResponse(updatedDraft),
        nextPickState: computedNextPickState,
      };
    });

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
  async applyTimeoutAction(params: ApplyTimeoutActionParams): Promise<ApplyPickResult | { actionTaken: false; reason: string }> {
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

  /**
   * Compute the next pick state without making any DB changes.
   */
  private computeNextPickState(
    draft: Draft,
    draftOrder: DraftOrderEntry[],
    engine: IDraftEngine,
    pickAssets: DraftPickAsset[] = []
  ): NextPickState {
    const totalRosters = draftOrder.length;
    const totalPicks = totalRosters * draft.rounds;
    const nextPick = draft.currentPick + 1;

    if (nextPick > totalPicks) {
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

    const nextRound = engine.getRound(nextPick, totalRosters);

    const actualPicker = engine.getActualPickerForPickNumber?.(
      draft,
      draftOrder,
      pickAssets,
      nextPick
    );

    const originalPicker = engine.getPickerForPickNumber(draft, draftOrder, nextPick);
    const nextPickerRosterId = actualPicker?.rosterId ?? originalPicker?.rosterId ?? null;

    const pickDeadline = engine.calculatePickDeadline(draft);

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
   * Validate that a player is eligible for this draft's player pool.
   */
  private async validatePlayerPoolEligibility(
    client: PoolClient,
    draft: Draft,
    playerId: number,
    playerRepo: PlayerRepository
  ): Promise<void> {
    const settings = draft.settings as DraftSettings;
    const playerPool = settings?.playerPool;

    if (!playerPool || playerPool.length === 0) {
      return;
    }

    const player = await playerRepo.findByIdWithClient(client, playerId);
    if (!player) {
      throw new NotFoundException('Player not found');
    }

    if (!this.isPlayerInPool(player, playerPool)) {
      const poolLabels = playerPool
        .map((p) => (p === 'veteran' ? 'veterans' : p === 'rookie' ? 'rookies' : 'college players'))
        .join(', ');
      throw new ValidationException(
        `This draft only allows ${poolLabels}. ${player.fullName} is not eligible.`
      );
    }
  }

  private isPlayerInPool(player: Player, playerPool: string[]): boolean {
    for (const poolType of playerPool) {
      if (poolType === 'veteran' && player.playerType === 'nfl' && (player.yearsExp === null || player.yearsExp > 0)) {
        return true;
      }
      if (poolType === 'rookie' && player.playerType === 'nfl' && player.yearsExp === 0) {
        return true;
      }
      if (poolType === 'college' && player.playerType === 'college') {
        return true;
      }
    }
    return false;
  }

  /**
   * Get the best available player for autopick.
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

    // Fall back to best available by ADP
    const bestAvailableResult = await client.query(
      `SELECT id FROM players
       WHERE player_type = 'nfl'
       AND id NOT IN (
         SELECT player_id FROM draft_picks WHERE draft_id = $1 AND player_id IS NOT NULL
       )
       ORDER BY adp ASC NULLS LAST
       LIMIT 1`,
      [draft.id]
    );

    if (bestAvailableResult.rows.length > 0) {
      return await playerRepo.findByIdWithClient(client, bestAvailableResult.rows[0].id);
    }

    return null;
  }

  /**
   * Emit pick-related events after transaction commits.
   */
  private emitPickEvents(
    draftId: number,
    pick: any,
    updatedDraft: Draft,
    nextPickState: NextPickState,
    player: Player | null | undefined,
    isAutoPick: boolean
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
