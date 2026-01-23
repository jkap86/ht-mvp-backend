import { DraftRepository } from './drafts.repository';
import { draftToResponse } from './drafts.model';
import { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import {
  NotFoundException,
  ForbiddenException,
} from '../../utils/exceptions';
import { DraftOrderService } from './draft-order.service';
import { DraftPickService } from './draft-pick.service';
import { DraftStateService } from './draft-state.service';

export class DraftService {
  constructor(
    private readonly draftRepo: DraftRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly orderService: DraftOrderService,
    private readonly pickService: DraftPickService,
    private readonly stateService: DraftStateService
  ) {}

  async getLeagueDrafts(leagueId: number, userId: string): Promise<any[]> {
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    const drafts = await this.draftRepo.findByLeagueId(leagueId);
    return drafts.map(draftToResponse);
  }

  async getDraftById(leagueId: number, draftId: number, userId: string): Promise<any> {
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    const draft = await this.draftRepo.findById(draftId);
    if (!draft || draft.leagueId !== leagueId) {
      throw new NotFoundException('Draft not found');
    }

    return draftToResponse(draft);
  }

  async createDraft(
    leagueId: number,
    userId: string,
    options: { draftType?: string; rounds?: number; pickTimeSeconds?: number }
  ): Promise<any> {
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can create drafts');
    }

    const draft = await this.draftRepo.create(
      leagueId,
      options.draftType || 'snake',
      options.rounds || 15,
      options.pickTimeSeconds || 90
    );

    // Create initial draft order
    await this.orderService.createInitialOrder(draft.id, leagueId);

    return draftToResponse(draft);
  }

  // Delegate to order service
  async getDraftOrder(leagueId: number, draftId: number, userId: string): Promise<any[]> {
    return this.orderService.getDraftOrder(leagueId, draftId, userId);
  }

  async randomizeDraftOrder(leagueId: number, draftId: number, userId: string): Promise<any[]> {
    return this.orderService.randomizeDraftOrder(leagueId, draftId, userId);
  }

  // Delegate to state service
  async startDraft(draftId: number, userId: string): Promise<any> {
    return this.stateService.startDraft(draftId, userId);
  }

  async deleteDraft(leagueId: number, draftId: number, userId: string): Promise<void> {
    return this.stateService.deleteDraft(leagueId, draftId, userId);
  }

  // Delegate to pick service
  async getDraftPicks(leagueId: number, draftId: number, userId: string): Promise<any[]> {
    return this.pickService.getDraftPicks(leagueId, draftId, userId);
  }

  async makePick(leagueId: number, draftId: number, userId: string, playerId: number): Promise<any> {
    return this.pickService.makePick(leagueId, draftId, userId, playerId);
  }
}
