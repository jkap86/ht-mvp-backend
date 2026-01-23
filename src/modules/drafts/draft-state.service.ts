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

    // Calculate remaining time on the clock
    const now = new Date();
    const remainingSeconds = draft.pickDeadline
      ? Math.max(0, Math.floor((draft.pickDeadline.getTime() - now.getTime()) / 1000))
      : draft.pickTimeSeconds;

    const updatedDraft = await this.draftRepo.update(draftId, {
      status: 'paused',
      pickDeadline: null,
      draftState: {
        ...draft.draftState,
        pausedAt: now.toISOString(),
        pausedBy: userId,
        remainingSeconds,
      },
    });

    const response = draftToResponse(updatedDraft);

    try {
      const socket = getSocketService();
      socket.emitDraftPaused(draftId, response);
    } catch {
      // Socket service may not be initialized in tests
    }

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

    // Calculate new deadline from remaining time
    const remainingSeconds = draft.draftState?.remainingSeconds ?? draft.pickTimeSeconds;
    const pickDeadline = new Date();
    pickDeadline.setSeconds(pickDeadline.getSeconds() + remainingSeconds);

    const updatedDraft = await this.draftRepo.update(draftId, {
      status: 'in_progress',
      pickDeadline,
      draftState: {
        ...draft.draftState,
        pausedAt: null,
        pausedBy: null,
        remainingSeconds: null,
      },
    });

    const response = draftToResponse(updatedDraft);

    try {
      const socket = getSocketService();
      socket.emitDraftResumed(draftId, response);
      socket.emitNextPick(draftId, {
        currentPick: updatedDraft.currentPick,
        currentRound: updatedDraft.currentRound,
        currentRosterId: updatedDraft.currentRosterId,
        pickDeadline,
      });
    } catch {
      // Socket service may not be initialized in tests
    }

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

    const updatedDraft = await this.draftRepo.update(draftId, {
      status: 'completed',
      completedAt: new Date(),
      pickDeadline: null,
      currentRosterId: null,
    });

    const response = draftToResponse(updatedDraft);

    try {
      const socket = getSocketService();
      socket.emitDraftCompleted(draftId, response);
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
