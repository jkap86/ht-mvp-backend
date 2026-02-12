import { Pool } from 'pg';
import { DraftRepository } from './drafts.repository';
import { Draft, DraftOrderEntry, DraftPick, DraftSettings, DraftResponse, draftToResponse } from './drafts.model';
import { validatePlayerPoolEligibility } from './draft-validation.utils';
import { DraftPickAssetRepository } from './draft-pick-asset.repository';
import { VetDraftPickSelectionRepository } from './vet-draft-pick-selection.repository';
import { draftPickAssetWithDetailsToResponse, DraftPickAsset } from './draft-pick-asset.model';
import { computeNextPickState, NextPickState } from './draft-pick-state.utils';
import type { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import type { RosterPlayersRepository } from '../rosters/rosters.repository';
import type { PlayerRepository } from '../players/players.repository';
import { NotFoundException, ForbiddenException, ValidationException, ConflictException, ErrorCode } from '../../utils/exceptions';
import { EventTypes, tryGetEventBus } from '../../shared/events';
import { DraftEngineFactory, IDraftEngine } from '../../engines';
import { finalizeDraftCompletion } from './draft-completion.utils';
import { runInDraftTransaction } from '../../shared/locks';
import { container, KEYS } from '../../container';
import { isInPauseWindow } from '../../shared/utils/time-utils';

/** Snake_case API response for a player pick */
export interface DraftPickResponse {
  id: number;
  draft_id: number;
  pick_number: number;
  round: number;
  pick_in_round: number;
  roster_id: number;
  player_id: number | null;
  is_auto_pick: boolean;
  picked_at: Date;
  player_name?: string;
  player_position?: string;
  player_team?: string;
  username?: string;
}

/** Snake_case API response for a pick asset selection */
export interface PickAssetSelectionResponse {
  id: number;
  draft_id: number;
  pick_number: number;
  round: number;
  pick_in_round: number;
  roster_id: number;
  player_id: null;
  is_auto_pick: false;
  picked_at: Date;
  draft_pick_asset_id: number;
  pick_asset_season: number;
  pick_asset_round: number;
  pick_asset_original_team: string;
  is_pick_asset: true;
}

/** Union type for all pick responses from getDraftPicks */
export type DraftPickResponseItem = DraftPickResponse | PickAssetSelectionResponse;

export class DraftPickService {
  constructor(
    private readonly draftRepo: DraftRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly engineFactory: DraftEngineFactory,
    private readonly playerRepo: PlayerRepository,
    private readonly rosterPlayersRepo: RosterPlayersRepository,
    private readonly pickAssetRepo?: DraftPickAssetRepository,
    private readonly vetPickSelectionRepo?: VetDraftPickSelectionRepository
  ) {}

  async getDraftPicks(leagueId: number, draftId: number, userId: string): Promise<DraftPickResponseItem[]> {
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    // Get regular player picks
    const playerPicks = await this.draftRepo.getDraftPicks(draftId);

    // Check if this draft has pick asset selections enabled
    const draft = await this.draftRepo.findById(draftId);
    const settings = draft?.settings as DraftSettings;

    // Transform playerPicks to snake_case API response format
    const transformPlayerPick = (pick: DraftPick) => ({
      id: pick.id,
      draft_id: pick.draftId,
      pick_number: pick.pickNumber,
      round: pick.round,
      pick_in_round: pick.pickInRound,
      roster_id: pick.rosterId,
      player_id: pick.playerId,
      is_auto_pick: pick.isAutoPick,
      picked_at: pick.pickedAt,
      player_name: pick.playerName,
      player_position: pick.playerPosition,
      player_team: pick.playerTeam,
      username: pick.username,
    });

    if (!settings?.includeRookiePicks || !this.vetPickSelectionRepo) {
      return playerPicks.map(transformPlayerPick);
    }

    // Get pick asset selections and transform to match DraftPick shape
    const pickAssetSelections = await this.vetPickSelectionRepo.findByDraftId(draftId);

    if (pickAssetSelections.length === 0) {
      return playerPicks.map(transformPlayerPick);
    }

    // Calculate total rosters to determine round from pick number
    const draftOrder = await this.draftRepo.getDraftOrder(draftId);
    const totalRosters = draftOrder.length;

    const transformedSelections = pickAssetSelections.map(selection => ({
      id: selection.id,
      draft_id: selection.draftId,
      pick_number: selection.pickNumber,
      round: totalRosters > 0 ? Math.ceil(selection.pickNumber / totalRosters) : 1,
      pick_in_round: totalRosters > 0 ? ((selection.pickNumber - 1) % totalRosters) + 1 : selection.pickNumber,
      roster_id: selection.rosterId,
      player_id: null,
      is_auto_pick: false,
      picked_at: selection.selectedAt,
      // Pick asset specific fields
      draft_pick_asset_id: selection.draftPickAssetId,
      pick_asset_season: selection.pickAsset.season,
      pick_asset_round: selection.pickAsset.round,
      pick_asset_original_team: selection.originalTeamName,
      is_pick_asset: true,
    }));

    // Merge and sort by pick number
    const transformedPlayerPicks = playerPicks.map(transformPlayerPick);
    const allPicks = [...transformedPlayerPicks, ...transformedSelections];
    allPicks.sort((a, b) => a.pick_number - b.pick_number);

    return allPicks;
  }

  async makePick(
    leagueId: number,
    draftId: number,
    userId: string,
    playerId: number,
    idempotencyKey?: string
  ): Promise<DraftPick> {
    // Validate league membership first (can stay outside lock - doesn't change during draft)
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    // Get user's roster (can stay outside lock - doesn't change during draft)
    const userRoster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
    if (!userRoster) {
      throw new ForbiddenException('You are not in this league');
    }

    // Get the pool for running the transaction
    const pool = container.resolve<Pool>(KEYS.POOL);

    // Run all state reads and the pick operation inside a single transaction with lock
    // This ensures we compute nextPickState with fresh data
    const { pick, updatedDraft, nextPickState, player } = await runInDraftTransaction(
      pool,
      draftId,
      async (client) => {
        // Read fresh draft state inside lock
        const draft = await this.draftRepo.findByIdWithClient(client, draftId);
        if (!draft) throw new NotFoundException('Draft not found');

        // Validate player eligibility with fresh draft settings inside lock
        await validatePlayerPoolEligibility(client, draft, playerId, this.playerRepo);

        // Verify draft belongs to the league
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

        // Check if draft is in overnight pause window (only for snake/linear drafts)
        if (
          draft.draftType !== 'auction' &&
          draft.overnightPauseEnabled &&
          draft.overnightPauseStart &&
          draft.overnightPauseEnd &&
          isInPauseWindow(new Date(), draft.overnightPauseStart, draft.overnightPauseEnd)
        ) {
          throw new ValidationException(
            'Picks are not allowed during the overnight pause window. The draft will resume automatically when the window ends.',
            ErrorCode.DRAFT_OVERNIGHT_PAUSE
          );
        }

        // Validate order is confirmed (non-auction drafts only)
        if (!draft.orderConfirmed && draft.draftType !== 'auction') {
          throw new ValidationException('Draft order must be confirmed before making picks');
        }

        // Read fresh draft order inside lock
        const draftOrder = await this.draftRepo.getDraftOrderWithClient(client, draftId);
        const engine = this.engineFactory.createEngine(draft.draftType);

        // Load pick assets inside lock for fresh traded picks state
        const pickAssets = this.pickAssetRepo
          ? await this.pickAssetRepo.findByDraftIdWithClient(client, draftId)
          : [];

        // Use getActualPickerForPickNumber to account for traded picks
        const actualPicker = engine.getActualPickerForPickNumber?.(
          draft,
          draftOrder,
          pickAssets,
          draft.currentPick
        );

        // Fall back to original picker logic if engine doesn't support traded picks
        const currentPickerRosterId =
          actualPicker?.rosterId ??
          engine.getPickerForPickNumber(draft, draftOrder, draft.currentPick)?.rosterId;

        if (currentPickerRosterId !== userRoster.id) {
          throw new ValidationException('It is not your turn to pick');
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
          rosterId: userRoster.id,
          playerId,
          nextPickState: computedNextPickState,
          idempotencyKey,
        });

        // If draft completed, run unified finalization inside the transaction
        if (computedNextPickState.status === 'completed') {
          await finalizeDraftCompletion(
            {
              draftRepo: this.draftRepo,
              leagueRepo: this.leagueRepo,
              rosterPlayersRepo: this.rosterPlayersRepo,
            },
            draftId,
            leagueId,
            client
          );
        }

        // Fetch player info for socket event (inside transaction using same client)
        const playerData = await this.playerRepo.findByIdWithClient(client, playerId);

        return {
          pick: result.pick,
          updatedDraft: result.draft,
          nextPickState: computedNextPickState,
          player: playerData,
        };
      }
    );

    // Emit events AFTER transaction commits
    const enrichedPick = {
      ...pick,
      is_auto_pick: false,
      player_name: player?.fullName,
      player_position: player?.position,
      player_team: player?.team,
    };

    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.DRAFT_PICK,
      payload: { draftId, pick: enrichedPick },
    });

    // Notify all users in draft that this player was removed from queues
    eventBus?.publish({
      type: EventTypes.DRAFT_QUEUE_UPDATED,
      payload: { draftId, playerId, action: 'removed' },
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
      // Draft completed
      eventBus?.publish({
        type: EventTypes.DRAFT_COMPLETED,
        payload: { draftId, draft: draftToResponse(updatedDraft) },
      });
    }

    return pick;
  }

  /**
   * Get available pick assets for a vet draft that has includeRookiePicks enabled.
   */
  async getAvailablePickAssets(leagueId: number, draftId: number, userId: string): Promise<Record<string, any>[]> {
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    const draft = await this.draftRepo.findById(draftId);
    if (!draft) throw new NotFoundException('Draft not found');
    if (draft.leagueId !== leagueId) {
      throw new NotFoundException('Draft not found in this league');
    }

    const settings = draft.settings as DraftSettings;
    if (!settings?.includeRookiePicks || !settings?.rookiePicksSeason) {
      return [];
    }

    if (!this.pickAssetRepo) {
      return [];
    }

    const assets = await this.pickAssetRepo.getAvailablePickAssetsForVetDraft(
      leagueId,
      draftId,
      settings.rookiePicksSeason,
      settings.rookiePicksRounds
    );

    return assets.map(draftPickAssetWithDetailsToResponse);
  }

  /**
   * Make a pick using a draft pick asset instead of a player.
   * Used in vet-only drafts with includeRookiePicks enabled.
   */
  async makePickAssetSelection(
    leagueId: number,
    draftId: number,
    userId: string,
    draftPickAssetId: number,
    idempotencyKey?: string
  ): Promise<PickAssetSelectionResponse> {
    // Validate league membership first (can stay outside lock)
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    if (!this.pickAssetRepo || !this.vetPickSelectionRepo) {
      throw new ValidationException('Pick asset selection not configured');
    }

    // Get user's roster (can stay outside lock - doesn't change during draft)
    const userRoster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
    if (!userRoster) {
      throw new ForbiddenException('You are not in this league');
    }

    // Pre-validate pick asset (can stay outside lock - asset data doesn't change mid-pick)
    const pickAsset = await this.pickAssetRepo.findByIdWithDetails(draftPickAssetId);
    if (!pickAsset) {
      throw new NotFoundException('Pick asset not found');
    }

    if (pickAsset.leagueId !== leagueId) {
      throw new ValidationException('Pick asset does not belong to this league');
    }

    // Get the pool for running the transaction
    const pool = container.resolve<Pool>(KEYS.POOL);

    // Run all state reads and the pick operation inside a single transaction with lock
    const { response, nextPickState, updatedDraft } = await runInDraftTransaction(
      pool,
      draftId,
      async (client) => {
        // Check if pick asset is in a pending trade INSIDE the transaction
        // to prevent TOCTOU race where a trade could be accepted between this check
        // and the pick asset selection below.
        const isInTradeResult = await client.query(
          `SELECT EXISTS(
            SELECT 1 FROM trade_items ti
            JOIN trades t ON ti.trade_id = t.id
            WHERE ti.draft_pick_asset_id = $1
              AND t.status IN ('pending', 'countered', 'accepted', 'in_review')
          )`,
          [draftPickAssetId]
        );
        if (isInTradeResult.rows[0].exists) {
          throw new ConflictException('Pick asset is currently in a pending trade');
        }

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

        // Check if draft is in overnight pause window (only for snake/linear drafts)
        if (
          draft.draftType !== 'auction' &&
          draft.overnightPauseEnabled &&
          draft.overnightPauseStart &&
          draft.overnightPauseEnd &&
          isInPauseWindow(new Date(), draft.overnightPauseStart, draft.overnightPauseEnd)
        ) {
          throw new ValidationException(
            'Picks are not allowed during the overnight pause window. The draft will resume automatically when the window ends.',
            ErrorCode.DRAFT_OVERNIGHT_PAUSE
          );
        }

        // Validate order is confirmed (non-auction drafts only)
        if (!draft.orderConfirmed && draft.draftType !== 'auction') {
          throw new ValidationException('Draft order must be confirmed before making picks');
        }

        // Verify this draft has includeRookiePicks enabled
        const settings = draft.settings as DraftSettings;
        if (!settings?.includeRookiePicks) {
          throw new ValidationException('This draft does not allow drafting pick assets');
        }

        // Validate season matches
        if (settings.rookiePicksSeason && pickAsset.season !== settings.rookiePicksSeason) {
          throw new ValidationException(
            `Pick asset is for season ${pickAsset.season}, but draft is configured for season ${settings.rookiePicksSeason}`
          );
        }

        // Read fresh draft order inside lock
        const draftOrder = await this.draftRepo.getDraftOrderWithClient(client, draftId);
        const engine = this.engineFactory.createEngine(draft.draftType);

        // Load pick assets inside lock for fresh traded picks state
        const pickAssets = await this.pickAssetRepo!.findByDraftIdWithClient(client, draftId);

        // Use getActualPickerForPickNumber to account for traded picks
        const actualPicker = engine.getActualPickerForPickNumber?.(
          draft,
          draftOrder,
          pickAssets,
          draft.currentPick
        );

        const currentPickerRosterId =
          actualPicker?.rosterId ??
          engine.getPickerForPickNumber(draft, draftOrder, draft.currentPick)?.rosterId;

        if (currentPickerRosterId !== userRoster.id) {
          throw new ValidationException('It is not your turn to pick');
        }

        // Calculate pick position
        const totalRosters = draftOrder.length;
        const pickInRound = engine.getPickInRound(draft.currentPick, totalRosters);

        // Compute next pick state with FRESH data inside the lock
        const computedNextPickState = this.computeNextPickState(draft, draftOrder, engine, pickAssets);

        // Make the pick asset selection using the client that already holds the lock
        const result = await this.draftRepo.makePickAssetSelectionTxWithClient(client, {
          draftId,
          expectedPickNumber: draft.currentPick,
          draftPickAssetId,
          rosterId: userRoster.id,
          nextPickState: computedNextPickState,
          idempotencyKey,
        });

        // If draft completed, run unified finalization inside the transaction
        if (computedNextPickState.status === 'completed') {
          await finalizeDraftCompletion(
            {
              draftRepo: this.draftRepo,
              leagueRepo: this.leagueRepo,
              rosterPlayersRepo: this.rosterPlayersRepo,
            },
            draftId,
            leagueId,
            client
          );
        }

        // Build response with pick asset info
        const pickResponse: PickAssetSelectionResponse = {
          id: result.selectionId,
          draft_id: draftId,
          pick_number: draft.currentPick,
          round: draft.currentRound,
          pick_in_round: pickInRound,
          roster_id: userRoster.id,
          player_id: null,
          is_auto_pick: false as const,
          picked_at: result.selectedAt,
          // Pick asset specific fields
          draft_pick_asset_id: draftPickAssetId,
          pick_asset_season: pickAsset.season,
          pick_asset_round: pickAsset.round,
          pick_asset_original_team: pickAsset.originalTeamName,
          is_pick_asset: true as const,
        };

        return {
          response: pickResponse,
          nextPickState: computedNextPickState,
          updatedDraft: result.draft,
        };
      }
    );

    // Emit events AFTER transaction commits
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.DRAFT_PICK,
      payload: { draftId, pick: response },
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
      // Draft completed
      eventBus?.publish({
        type: EventTypes.DRAFT_COMPLETED,
        payload: { draftId, draft: draftToResponse(updatedDraft) },
      });
    }

    return response;
  }

  /**
   * Pre-compute the next pick state without making any DB changes.
   * This is used by the atomic makePickAndAdvanceTx to update draft state.
   *
   * Delegates to the shared computeNextPickState utility.
   */
  private computeNextPickState(
    draft: Draft,
    draftOrder: DraftOrderEntry[],
    engine: IDraftEngine,
    pickAssets: DraftPickAsset[] = []
  ): NextPickState {
    return computeNextPickState(draft, draftOrder, engine, pickAssets);
  }

}
