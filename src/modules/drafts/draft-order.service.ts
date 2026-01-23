import { Pool } from 'pg';
import { DraftRepository } from './drafts.repository';
import { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import {
  ForbiddenException,
  ValidationException,
} from '../../utils/exceptions';

/**
 * Fisher-Yates shuffle algorithm for unbiased random ordering
 */
function fisherYatesShuffle<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export class DraftOrderService {
  constructor(
    private readonly draftRepo: DraftRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly db?: Pool
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

    // Get rosters and shuffle using unbiased Fisher-Yates algorithm
    const rosters = await this.rosterRepo.findByLeagueId(leagueId);
    if (rosters.length === 0) {
      throw new ValidationException('No rosters found in league');
    }
    const shuffled = fisherYatesShuffle(rosters);

    // Use transaction to ensure atomic clear and recreate
    if (this.db) {
      const client = await this.db.connect();
      try {
        await client.query('BEGIN');

        // Clear existing order
        await client.query('DELETE FROM draft_order WHERE draft_id = $1', [draftId]);

        // Create new order in a single batch insert
        const values: any[] = [];
        const placeholders: string[] = [];
        for (let i = 0; i < shuffled.length; i++) {
          const offset = i * 3;
          placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`);
          values.push(draftId, shuffled[i].id, i + 1);
        }

        await client.query(
          `INSERT INTO draft_order (draft_id, roster_id, draft_position) VALUES ${placeholders.join(', ')}`,
          values
        );

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } else {
      // Fallback to non-transactional (for backwards compatibility)
      await this.draftRepo.clearDraftOrder(draftId);
      for (let i = 0; i < shuffled.length; i++) {
        await this.draftRepo.createDraftOrder(draftId, shuffled[i].id, i + 1);
      }
    }

    return this.draftRepo.getDraftOrder(draftId);
  }

  async createInitialOrder(draftId: number, leagueId: number): Promise<void> {
    const rosters = await this.rosterRepo.findByLeagueId(leagueId);
    if (rosters.length === 0) return;

    // Use batch insert for better performance and atomicity
    if (this.db) {
      const values: any[] = [];
      const placeholders: string[] = [];
      for (let i = 0; i < rosters.length; i++) {
        const offset = i * 3;
        placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`);
        values.push(draftId, rosters[i].id, i + 1);
      }

      await this.db.query(
        `INSERT INTO draft_order (draft_id, roster_id, draft_position) VALUES ${placeholders.join(', ')}`,
        values
      );
    } else {
      // Fallback to sequential inserts
      for (let i = 0; i < rosters.length; i++) {
        await this.draftRepo.createDraftOrder(draftId, rosters[i].id, i + 1);
      }
    }
  }
}
