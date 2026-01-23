import { randomBytes } from 'crypto';
import { DraftRepository } from './drafts.repository';
import { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import {
  ForbiddenException,
  ValidationException,
} from '../../utils/exceptions';

/**
 * Cryptographically secure Fisher-Yates shuffle.
 * Uses crypto.randomBytes() for unbiased randomization.
 */
function secureShuffleArray<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    // Generate a random index from 0 to i (inclusive)
    const randomBuffer = randomBytes(4);
    const randomValue = randomBuffer.readUInt32BE(0);
    const j = randomValue % (i + 1);

    // Swap elements
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

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

    // Get rosters and shuffle using crypto-secure randomization
    const rosters = await this.rosterRepo.findByLeagueId(leagueId);
    const shuffled = secureShuffleArray(rosters);

    // Atomically update draft order in a single transaction
    const rosterIds = shuffled.map(r => r.id);
    await this.draftRepo.updateDraftOrderAtomic(draftId, rosterIds);

    return this.draftRepo.getDraftOrder(draftId);
  }

  async createInitialOrder(draftId: number, leagueId: number): Promise<void> {
    const rosters = await this.rosterRepo.findByLeagueId(leagueId);
    for (let i = 0; i < rosters.length; i++) {
      await this.draftRepo.createDraftOrder(draftId, rosters[i].id, i + 1);
    }
  }
}
