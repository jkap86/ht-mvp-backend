import { DraftRepository } from './drafts.repository';
import { draftToResponse } from './drafts.model';
import { LeagueRepository } from '../leagues/leagues.repository';
import {
  NotFoundException,
  ForbiddenException,
  ValidationException,
} from '../../utils/exceptions';
import { getSocketService } from '../../socket';

export class DraftStateService {
  constructor(
    private readonly draftRepo: DraftRepository,
    private readonly leagueRepo: LeagueRepository
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

    const firstPicker = draftOrder.find(o => o.draftPosition === 1);

    const pickDeadline = new Date();
    pickDeadline.setSeconds(pickDeadline.getSeconds() + draft.pickTimeSeconds);

    const updatedDraft = await this.draftRepo.update(draftId, {
      status: 'in_progress',
      startedAt: new Date(),
      currentPick: 1,
      currentRound: 1,
      currentRosterId: firstPicker?.rosterId || null,
      pickDeadline,
    });

    const response = draftToResponse(updatedDraft);

    // Emit socket event
    try {
      const socket = getSocketService();
      socket.emitDraftStarted(draftId, response);
      socket.emitNextPick(draftId, {
        currentPick: 1,
        currentRound: 1,
        currentRosterId: firstPicker?.rosterId,
        pickDeadline,
      });
    } catch {
      // Socket service may not be initialized in tests
    }

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
}
