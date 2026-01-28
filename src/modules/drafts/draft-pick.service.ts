import { DraftRepository } from './drafts.repository';
import { Draft, DraftOrderEntry, draftToResponse } from './drafts.model';
import { DraftPickAssetRepository } from './draft-pick-asset.repository';
import { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import { RosterPlayersRepository } from '../rosters/rosters.repository';
import { PlayerRepository } from '../players/players.repository';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
  ConflictException,
} from '../../utils/exceptions';
import { tryGetSocketService } from '../../socket';
import { DraftEngineFactory, IDraftEngine } from '../../engines';

export class DraftPickService {
  constructor(
    private readonly draftRepo: DraftRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly engineFactory: DraftEngineFactory,
    private readonly playerRepo: PlayerRepository,
    private readonly rosterPlayersRepo: RosterPlayersRepository,
    private readonly pickAssetRepo?: DraftPickAssetRepository
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
    const pickAssets = this.pickAssetRepo
      ? await this.pickAssetRepo.findByDraftId(draftId)
      : [];

    // Use getActualPickerForPickNumber to account for traded picks
    const actualPicker = engine.getActualPickerForPickNumber?.(
      draft,
      draftOrder,
      pickAssets,
      draft.currentPick
    );

    // Fall back to original picker logic if engine doesn't support traded picks
    const currentPickerRosterId = actualPicker?.rosterId
      ?? engine.getPickerForPickNumber(draft, draftOrder, draft.currentPick)?.rosterId;

    if (currentPickerRosterId !== userRoster.id) {
      throw new ValidationException('It is not your turn to pick');
    }

    // Calculate pick position
    const totalRosters = draftOrder.length;
    const pickInRound = engine.getPickInRound(draft.currentPick, totalRosters);

    // Make the pick atomically with advisory lock (handles race condition check inside transaction)
    const pick = await this.draftRepo.createDraftPickWithCleanup(
      draftId,
      draft.currentPick,
      draft.currentRound,
      pickInRound,
      userRoster.id,
      playerId,
      idempotencyKey
    );

    // Advance to next pick
    const nextPickInfo = await this.advanceToNextPick(draft, draftOrder, engine, pickAssets);

    // Enrich pick with player info for socket event
    const player = await this.playerRepo.findById(playerId);
    const enrichedPick = {
      ...pick,
      is_auto_pick: false,
      player_name: player?.fullName,
      player_position: player?.position,
      player_team: player?.team,
    };

    // Emit socket events
    const socket = tryGetSocketService();
    socket?.emitDraftPick(draftId, enrichedPick);

    // Notify all users in draft that this player was removed from queues
    socket?.emitQueueUpdated(draftId, { playerId, action: 'removed' });

    if (nextPickInfo) {
      socket?.emitNextPick(draftId, nextPickInfo);
    } else {
      // Draft completed
      const completedDraft = await this.draftRepo.findById(draftId);
      if (completedDraft) {
        socket?.emitDraftCompleted(draftId, draftToResponse(completedDraft));
      }
    }

    return pick;
  }

  private async advanceToNextPick(
    draft: Draft,
    draftOrder: DraftOrderEntry[],
    engine: IDraftEngine,
    pickAssets: import('./draft-pick-asset.model').DraftPickAsset[] = []
  ): Promise<any | null> {
    const totalRosters = draftOrder.length;
    const totalPicks = totalRosters * draft.rounds;
    const nextPick = draft.currentPick + 1;

    if (nextPick > totalPicks) {
      // Draft complete - populate rosters with drafted players first
      await this.populateRostersFromDraft(draft.id, draft.leagueId);

      await this.draftRepo.update(draft.id, {
        status: 'completed',
        completedAt: new Date(),
        currentRosterId: null,
        pickDeadline: null,
      });
      return null;
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

    await this.draftRepo.update(draft.id, {
      currentPick: nextPick,
      currentRound: nextRound,
      currentRosterId: nextPickerRosterId,
      pickDeadline,
    });

    return {
      currentPick: nextPick,
      currentRound: nextRound,
      currentRosterId: nextPickerRosterId,
      originalRosterId: actualPicker?.originalRosterId ?? originalPicker?.rosterId ?? null,
      isTraded: actualPicker?.isTraded ?? false,
      pickDeadline,
    };
  }

  private async populateRostersFromDraft(draftId: number, leagueId: number): Promise<void> {
    const picks = await this.draftRepo.getDraftPicks(draftId);
    const league = await this.leagueRepo.findById(leagueId);
    if (!league) return;

    const season = parseInt(league.season, 10);

    for (const pick of picks) {
      // Skip picks without a player (shouldn't happen for completed picks)
      if (pick.playerId === null) continue;

      await this.rosterPlayersRepo.addDraftedPlayer(
        pick.rosterId,
        pick.playerId,
        leagueId,
        season,
        0 // week 0 for draft
      );
    }
  }
}
