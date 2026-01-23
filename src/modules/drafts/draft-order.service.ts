import { DraftRepository } from './drafts.repository';
import { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import {
  ForbiddenException,
  ValidationException,
} from '../../utils/exceptions';

export class DraftOrderService {
  constructor(
    private readonly draftRepo: DraftRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly rosterRepo: RosterRepository
  ) {}

  async getDraftOrder(leagueId: number, draftId: number, userId: string): Promise<any[]> {
    const isMember = await this.leagueRepo.isUserMember(leagueId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this league');
    }

    return this.draftRepo.getDraftOrder(draftId);
  }

  async randomizeDraftOrder(leagueId: number, draftId: number, userId: string): Promise<any[]> {
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can randomize draft order');
    }

    const draft = await this.draftRepo.findById(draftId);
    if (!draft || draft.status !== 'not_started') {
      throw new ValidationException('Can only randomize order before draft starts');
    }

    // Get rosters and shuffle
    const rosters = await this.rosterRepo.findByLeagueId(leagueId);
    const shuffled = [...rosters].sort(() => Math.random() - 0.5);

    // Clear and recreate order
    await this.draftRepo.clearDraftOrder(draftId);
    for (let i = 0; i < shuffled.length; i++) {
      await this.draftRepo.createDraftOrder(draftId, shuffled[i].id, i + 1);
    }

    return this.draftRepo.getDraftOrder(draftId);
  }

  async createInitialOrder(draftId: number, leagueId: number): Promise<void> {
    const rosters = await this.rosterRepo.findByLeagueId(leagueId);
    for (let i = 0; i < rosters.length; i++) {
      await this.draftRepo.createDraftOrder(draftId, rosters[i].id, i + 1);
    }
  }
}
