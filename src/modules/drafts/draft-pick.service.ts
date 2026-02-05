import { DraftRepository } from './drafts.repository';
import { Draft, DraftOrderEntry, DraftSettings, draftToResponse } from './drafts.model';
import { DraftPickAssetRepository } from './draft-pick-asset.repository';
import { VetDraftPickSelectionRepository } from './vet-draft-pick-selection.repository';
import { draftPickAssetWithDetailsToResponse } from './draft-pick-asset.model';
import { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import { RosterPlayersRepository } from '../rosters/rosters.repository';
import { PlayerRepository } from '../players/players.repository';
import { NotFoundException, ForbiddenException, ValidationException } from '../../utils/exceptions';
import { tryGetSocketService } from '../../socket';
import { DraftEngineFactory, IDraftEngine } from '../../engines';
import { finalizeDraftCompletion } from './draft-completion.utils';

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

  async getDraftPicks(leagueId: number, draftId: number, userId: string): Promise<any[]> {
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    return this.draftRepo.getDraftPicks(draftId);
  }

  async makePick(
    leagueId: number,
    draftId: number,
    userId: string,
    playerId: number,
    idempotencyKey?: string
  ): Promise<any> {
    // Validate league membership first
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    const draft = await this.draftRepo.findById(draftId);
    if (!draft) throw new NotFoundException('Draft not found');

    // Verify draft belongs to the league
    if (draft.leagueId !== leagueId) {
      throw new NotFoundException('Draft not found in this league');
    }

    if (draft.status !== 'in_progress') {
      throw new ValidationException('Draft is not in progress');
    }

    // Get user's roster
    const userRoster = await this.rosterRepo.findByLeagueAndUser(draft.leagueId, userId);
    if (!userRoster) {
      throw new ForbiddenException('You are not in this league');
    }

    // Check if it's user's turn (accounting for traded picks)
    const draftOrder = await this.draftRepo.getDraftOrder(draftId);
    const engine = this.engineFactory.createEngine(draft.draftType);

    // Load pick assets to check for traded picks
    const pickAssets = this.pickAssetRepo ? await this.pickAssetRepo.findByDraftId(draftId) : [];

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

    // Pre-compute the next pick state BEFORE the atomic transaction
    const nextPickState = this.computeNextPickState(draft, draftOrder, engine, pickAssets);

    // Make the pick AND advance draft state atomically in a single transaction
    // This prevents race conditions where pick inserts but draft state doesn't advance
    const { pick, draft: updatedDraft } = await this.draftRepo.makePickAndAdvanceTx({
      draftId,
      expectedPickNumber: draft.currentPick,
      round: draft.currentRound,
      pickInRound,
      rosterId: userRoster.id,
      playerId,
      nextPickState,
      idempotencyKey,
    });

    // If draft completed, run unified finalization (rosters, league status, schedule)
    if (nextPickState.status === 'completed') {
      await finalizeDraftCompletion(
        {
          draftRepo: this.draftRepo,
          leagueRepo: this.leagueRepo,
          rosterPlayersRepo: this.rosterPlayersRepo,
        },
        draftId,
        leagueId
      );
    }

    // Enrich pick with player info for socket event
    const player = await this.playerRepo.findById(playerId);
    const enrichedPick = {
      ...pick,
      is_auto_pick: false,
      player_name: player?.fullName,
      player_position: player?.position,
      player_team: player?.team,
    };

    // Emit socket events AFTER transaction commits
    const socket = tryGetSocketService();
    socket?.emitDraftPick(draftId, enrichedPick);

    // Notify all users in draft that this player was removed from queues
    socket?.emitQueueUpdated(draftId, { playerId, action: 'removed' });

    if (nextPickState.status !== 'completed') {
      socket?.emitNextPick(draftId, {
        currentPick: nextPickState.currentPick,
        currentRound: nextPickState.currentRound,
        currentRosterId: nextPickState.currentRosterId,
        originalRosterId: nextPickState.originalRosterId,
        isTraded: nextPickState.isTraded,
        pickDeadline: nextPickState.pickDeadline,
      });
    } else {
      // Draft completed
      socket?.emitDraftCompleted(draftId, draftToResponse(updatedDraft));
    }

    return pick;
  }

  /**
   * Get available pick assets for a vet draft that has includeRookiePicks enabled.
   */
  async getAvailablePickAssets(leagueId: number, draftId: number, userId: string): Promise<any[]> {
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
      settings.rookiePicksSeason
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
  ): Promise<any> {
    // Validate league membership first
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    const draft = await this.draftRepo.findById(draftId);
    if (!draft) throw new NotFoundException('Draft not found');

    if (draft.leagueId !== leagueId) {
      throw new NotFoundException('Draft not found in this league');
    }

    if (draft.status !== 'in_progress') {
      throw new ValidationException('Draft is not in progress');
    }

    // Verify this draft has includeRookiePicks enabled
    const settings = draft.settings as DraftSettings;
    if (!settings?.includeRookiePicks) {
      throw new ValidationException('This draft does not allow drafting pick assets');
    }

    if (!this.pickAssetRepo || !this.vetPickSelectionRepo) {
      throw new ValidationException('Pick asset selection not configured');
    }

    // Get user's roster
    const userRoster = await this.rosterRepo.findByLeagueAndUser(draft.leagueId, userId);
    if (!userRoster) {
      throw new ForbiddenException('You are not in this league');
    }

    // Check if it's user's turn (accounting for traded picks)
    const draftOrder = await this.draftRepo.getDraftOrder(draftId);
    const engine = this.engineFactory.createEngine(draft.draftType);

    // Load pick assets to check for traded picks
    const pickAssets = await this.pickAssetRepo.findByDraftId(draftId);

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

    // Validate the pick asset exists and belongs to the correct season
    const pickAsset = await this.pickAssetRepo.findByIdWithDetails(draftPickAssetId);
    if (!pickAsset) {
      throw new NotFoundException('Pick asset not found');
    }

    if (pickAsset.leagueId !== leagueId) {
      throw new ValidationException('Pick asset does not belong to this league');
    }

    if (settings.rookiePicksSeason && pickAsset.season !== settings.rookiePicksSeason) {
      throw new ValidationException(
        `Pick asset is for season ${pickAsset.season}, but draft is configured for season ${settings.rookiePicksSeason}`
      );
    }

    // Check if asset already selected in this vet draft
    const alreadySelected = await this.vetPickSelectionRepo.isAssetSelected(draftId, draftPickAssetId);
    if (alreadySelected) {
      throw new ValidationException('This pick asset has already been drafted');
    }

    // Calculate pick position
    const totalRosters = draftOrder.length;
    const pickInRound = engine.getPickInRound(draft.currentPick, totalRosters);

    // Pre-compute the next pick state
    const nextPickState = this.computeNextPickState(draft, draftOrder, engine, pickAssets);

    // Record the selection, transfer ownership, and update draft state atomically
    // This prevents race conditions where selection is created but draft state doesn't advance
    const { selectionId, selectedAt, draft: updatedDraft } =
      await this.draftRepo.makePickAssetSelectionTx({
        draftId,
        expectedPickNumber: draft.currentPick,
        draftPickAssetId,
        rosterId: userRoster.id,
        nextPickState,
        idempotencyKey,
      });

    // If draft completed, run unified finalization (rosters, league status, schedule)
    if (nextPickState.status === 'completed') {
      await finalizeDraftCompletion(
        {
          draftRepo: this.draftRepo,
          leagueRepo: this.leagueRepo,
          rosterPlayersRepo: this.rosterPlayersRepo,
        },
        draftId,
        leagueId
      );
    }

    // Build response with pick asset info
    const response = {
      id: selectionId,
      draft_id: draftId,
      pick_number: draft.currentPick,
      round: draft.currentRound,
      pick_in_round: pickInRound,
      roster_id: userRoster.id,
      player_id: null,
      is_auto_pick: false,
      picked_at: selectedAt,
      // Pick asset specific fields
      draft_pick_asset_id: draftPickAssetId,
      pick_asset_season: pickAsset.season,
      pick_asset_round: pickAsset.round,
      pick_asset_original_team: pickAsset.originalTeamName,
      is_pick_asset: true,
    };

    // Emit socket events AFTER transaction commits
    const socket = tryGetSocketService();
    socket?.emitDraftPick(draftId, response);

    if (nextPickState.status !== 'completed') {
      socket?.emitNextPick(draftId, {
        currentPick: nextPickState.currentPick,
        currentRound: nextPickState.currentRound,
        currentRosterId: nextPickState.currentRosterId,
        originalRosterId: nextPickState.originalRosterId,
        isTraded: nextPickState.isTraded,
        pickDeadline: nextPickState.pickDeadline,
      });
    } else {
      // Draft completed
      socket?.emitDraftCompleted(draftId, draftToResponse(updatedDraft));
    }

    return response;
  }

  /**
   * Pre-compute the next pick state without making any DB changes.
   * This is used by the atomic makePickAndAdvanceTx to update draft state.
   */
  private computeNextPickState(
    draft: Draft,
    draftOrder: DraftOrderEntry[],
    engine: IDraftEngine,
    pickAssets: import('./draft-pick-asset.model').DraftPickAsset[] = []
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

    const nextRound = engine.getRound(nextPick, totalRosters);

    // Use getActualPickerForPickNumber to account for traded picks
    const actualPicker = engine.getActualPickerForPickNumber?.(
      draft,
      draftOrder,
      pickAssets,
      nextPick
    );

    // Fall back to original picker logic if engine doesn't support traded picks
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
}
