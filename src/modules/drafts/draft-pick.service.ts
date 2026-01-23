import { DraftRepository } from './drafts.repository';
import { Draft, DraftOrderEntry, draftToResponse } from './drafts.model';
import { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
  ConflictException,
} from '../../utils/exceptions';
import { getSocketService } from '../../socket';
import { DraftEngineFactory, IDraftEngine } from '../../engines';

export class DraftPickService {
  constructor(
    private readonly draftRepo: DraftRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly engineFactory: DraftEngineFactory
  ) {}

  async getDraftPicks(leagueId: number, draftId: number, userId: string): Promise<any[]> {
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    return this.draftRepo.getDraftPicks(draftId);
  }

  async makePick(leagueId: number, draftId: number, userId: string, playerId: number): Promise<any> {
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

    // Check if it's user's turn
    const draftOrder = await this.draftRepo.getDraftOrder(draftId);
    const engine = this.engineFactory.createEngine(draft.draftType);
    const currentPicker = engine.getPickerForPickNumber(draft, draftOrder, draft.currentPick);

    if (currentPicker?.rosterId !== userRoster.id) {
      throw new ValidationException('It is not your turn to pick');
    }

    // Check if player already drafted
    const isDrafted = await this.draftRepo.isPlayerDrafted(draftId, playerId);
    if (isDrafted) {
      throw new ConflictException('Player has already been drafted');
    }

    // Calculate pick position
    const totalRosters = draftOrder.length;
    const pickInRound = engine.getPickInRound(draft.currentPick, totalRosters);

    // Make the pick and remove from all queues atomically
    const pick = await this.draftRepo.createDraftPickWithCleanup(
      draftId,
      draft.currentPick,
      draft.currentRound,
      pickInRound,
      userRoster.id,
      playerId
    );

    // Advance to next pick
    const nextPickInfo = await this.advanceToNextPick(draft, draftOrder, engine);

    // Emit socket events
    try {
      const socket = getSocketService();
      socket.emitDraftPick(draftId, pick);

      // Notify all users in draft that this player was removed from queues
      socket.emitQueueUpdated(draftId, { playerId, action: 'removed' });

      if (nextPickInfo) {
        socket.emitNextPick(draftId, nextPickInfo);
      } else {
        // Draft completed
        const completedDraft = await this.draftRepo.findById(draftId);
        if (completedDraft) {
          socket.emitDraftCompleted(draftId, draftToResponse(completedDraft));
        }
      }
    } catch {
      // Socket service may not be initialized in tests
    }

    return pick;
  }

  private async advanceToNextPick(
    draft: Draft,
    draftOrder: DraftOrderEntry[],
    engine: IDraftEngine
  ): Promise<any | null> {
    const totalRosters = draftOrder.length;
    const totalPicks = totalRosters * draft.rounds;
    const nextPick = draft.currentPick + 1;

    if (nextPick > totalPicks) {
      // Draft complete
      await this.draftRepo.update(draft.id, {
        status: 'completed',
        completedAt: new Date(),
        currentRosterId: null,
        pickDeadline: null,
      });
      return null;
    }

    const nextRound = engine.getRound(nextPick, totalRosters);
    const nextPicker = engine.getPickerForPickNumber(draft, draftOrder, nextPick);

    const pickDeadline = engine.calculatePickDeadline(draft);

    await this.draftRepo.update(draft.id, {
      currentPick: nextPick,
      currentRound: nextRound,
      currentRosterId: nextPicker?.rosterId || null,
      pickDeadline,
    });

    return {
      currentPick: nextPick,
      currentRound: nextRound,
      currentRosterId: nextPicker?.rosterId || null,
      pickDeadline,
    };
  }
}
