import { DraftRepository } from './drafts.repository';
import { DraftSettings, draftToResponse } from './drafts.model';
import { LeagueRepository } from '../leagues/leagues.repository';
import { RosterPlayersRepository } from '../rosters/rosters.repository';
import { DraftEngineFactory } from '../../engines';
import { NotFoundException, ForbiddenException, ValidationException } from '../../utils/exceptions';
import { tryGetSocketService } from '../../socket';
import { finalizeDraftCompletion } from './draft-completion.utils';
import { ScheduleGeneratorService } from '../matchups/schedule-generator.service';
import { DraftPickAssetRepository } from './draft-pick-asset.repository';
import { container, KEYS } from '../../container';

export class DraftStateService {
  constructor(
    private readonly draftRepo: DraftRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly engineFactory: DraftEngineFactory,
    private readonly rosterPlayersRepo: RosterPlayersRepository,
    private readonly scheduleGeneratorService?: ScheduleGeneratorService,
    private readonly pickAssetRepo?: DraftPickAssetRepository
  ) {}

  async startDraft(draftId: number, userId: string): Promise<any> {
    const draft = await this.draftRepo.findById(draftId);
    if (!draft) throw new NotFoundException('Draft not found');

    const isCommissioner = await this.leagueRepo.isCommissioner(draft.leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can start the draft');
    }

    if (draft.status !== 'not_started') {
      throw new ValidationException('Draft has already started');
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

    // Determine first picker, accounting for traded picks
    const engine = this.engineFactory.createEngine(draft.draftType);
    let firstPickerRosterId: number | null = null;

    if (this.pickAssetRepo) {
      const pickAssets = await this.pickAssetRepo.findByDraftId(draftId);
      const actualPicker = engine.getActualPickerForPickNumber(draft, draftOrder, pickAssets, 1);
      firstPickerRosterId = actualPicker?.rosterId ?? null;
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

    // Emit socket event
    const socket = tryGetSocketService();
    socket?.emitDraftStarted(draftId, response);
    socket?.emitNextPick(draftId, {
      currentPick: 1,
      currentRound: 1,
      currentRosterId: firstPickerRosterId,  // Use traded-pick-aware ID
      pickDeadline,
      status: 'in_progress',
    });

    // For fast auctions, also emit nominator changed so frontend shows correct nominator name
    if (isFastAuction && firstPicker) {
      socket?.emitAuctionNominatorChanged(draftId, {
        nominatorRosterId: firstPicker.rosterId,
        nominationNumber: 1,
        nominationDeadline: pickDeadline?.toISOString(),
      });
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

    // Check if this is a slow auction (no deadline/timer)
    const isSlowAuction = draft.draftType === 'auction' && draft.settings?.auctionMode !== 'fast';

    // Calculate remaining time on the clock (only for timed drafts)
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

    const socket = tryGetSocketService();
    socket?.emitDraftPaused(draftId, response);

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

    // Check if this is a slow auction (no deadline/timer)
    const isSlowAuction = draft.draftType === 'auction' && draft.settings?.auctionMode !== 'fast';

    // Calculate new deadline from remaining time (only for timed drafts)
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

    const socket = tryGetSocketService();
    socket?.emitDraftResumed(draftId, response);
    socket?.emitNextPick(draftId, {
      currentPick: updatedDraft.currentPick,
      currentRound: updatedDraft.currentRound,
      currentRosterId: updatedDraft.currentRosterId,
      pickDeadline,
      status: 'in_progress',
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

    const socket = tryGetSocketService();
    socket?.emitDraftCompleted(draftId, response);

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
    const draft = await this.draftRepo.findById(draftId);
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

    // Pre-compute the previous state using engine
    const draftOrder = await this.draftRepo.getDraftOrder(draftId);
    const engine = this.engineFactory.createEngine(draft.draftType);
    const totalRosters = draftOrder.length;

    // Get the last pick number to determine what state to revert to
    // (We need to know this before the atomic transaction to compute the state)
    const picks = await this.draftRepo.getDraftPicks(draftId, 1);
    if (picks.length === 0 && !includeRookiePicks) {
      throw new ValidationException('No picks to undo');
    }
    const lastPick = draft.status === 'completed'
      ? totalRosters * draft.rounds  // If completed, last pick was the final one
      : draft.currentPick - 1;       // Otherwise, it's one before current
    const prevPick = lastPick;       // After undo, this becomes the current pick
    const prevRound = engine.getRound(prevPick, totalRosters);

    // Fetch pick assets to account for traded picks
    let prevPickerRosterId: number | null = null;
    try {
      const pickAssetRepo = container.resolve<DraftPickAssetRepository>(KEYS.PICK_ASSET_REPO);
      const pickAssets = await pickAssetRepo.findByDraftId(draftId);
      const actualPicker = engine.getActualPickerForPickNumber(draft, draftOrder, pickAssets, prevPick);
      prevPickerRosterId = actualPicker?.rosterId || null;
    } catch {
      // Fallback to original picker if pick assets not available
      const prevPicker = engine.getPickerForPickNumber(draft, draftOrder, prevPick);
      prevPickerRosterId = prevPicker?.rosterId || null;
    }

    // Calculate new deadline only if draft was in progress (not paused)
    const shouldSetDeadline = draft.status === 'in_progress' || wasCompleted;
    const pickDeadline = shouldSetDeadline ? new Date() : null;
    if (pickDeadline) {
      pickDeadline.setSeconds(pickDeadline.getSeconds() + draft.pickTimeSeconds);
    }

    // Determine the target status after undo
    const targetStatus = wasCompleted ? 'in_progress' : (draft.status as 'in_progress' | 'paused');

    // Delete the most recent pick (player or pick-asset) and update draft state atomically
    const { undonePick, undoneSelection, draft: updatedDraft } = await this.draftRepo.undoLastPickTx({
      draftId,
      prevPickState: {
        currentPick: prevPick,
        currentRound: prevRound,
        currentRosterId: prevPickerRosterId,
        pickDeadline,
        status: targetStatus,
        completedAt: null,
      },
      includeRookiePicks,
    });

    if (!undonePick && !undoneSelection) {
      throw new ValidationException('No picks to undo');
    }

    // Build the undone item for socket event (either player pick or pick-asset selection)
    const undoneItem = undonePick || {
      id: undoneSelection!.id,
      pickNumber: undoneSelection!.pickNumber,
      rosterId: undoneSelection!.rosterId,
      draftPickAssetId: undoneSelection!.draftPickAssetId,
      isPickAsset: true,
    };

    const response = draftToResponse(updatedDraft);

    // Emit socket events AFTER transaction commits
    const socket = tryGetSocketService();
    socket?.emitPickUndone(draftId, { pick: undoneItem, draft: response });
    if (updatedDraft.status === 'in_progress') {
      socket?.emitNextPick(draftId, {
        currentPick: prevPick,
        currentRound: prevRound,
        currentRosterId: prevPickerRosterId,
        pickDeadline,
        status: 'in_progress',
      });
    }

    return { draft: response, undone: undoneItem };
  }
}
