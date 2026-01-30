import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { DraftRepository } from './drafts.repository';
import { DraftPickAssetRepository } from './draft-pick-asset.repository';
import { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import { ForbiddenException, NotFoundException, ValidationException } from '../../utils/exceptions';
import { tryGetSocketService } from '../../socket';

/**
 * Cryptographically secure Fisher-Yates shuffle.
 * Uses crypto.randomBytes() with rejection sampling for unbiased randomization.
 */
function secureShuffleArray<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const range = i + 1;
    // Calculate the largest multiple of range that fits in 32 bits
    // to avoid modulo bias (2^32 isn't evenly divisible by all ranges)
    const maxUnbiased = Math.floor(0x100000000 / range) * range;

    let randomValue: number;
    do {
      const randomBuffer = randomBytes(4);
      randomValue = randomBuffer.readUInt32BE(0);
    } while (randomValue >= maxUnbiased);

    const j = randomValue % range;
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export class DraftOrderService {
  constructor(
    private readonly db: Pool,
    private readonly draftRepo: DraftRepository,
    private readonly leagueRepo: LeagueRepository,
    private readonly rosterRepo: RosterRepository,
    private readonly pickAssetRepo?: DraftPickAssetRepository
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

    // Get league to know total roster count
    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      throw new NotFoundException('League not found');
    }

    // Get existing rosters
    const existingRosters = await this.rosterRepo.findByLeagueId(leagueId);
    const existingCount = existingRosters.length;
    const targetCount = league.totalRosters;

    // Create empty rosters for unfilled slots (in a transaction)
    if (existingCount < targetCount) {
      const client = await this.db.connect();
      try {
        await client.query('BEGIN');
        // Advisory lock to prevent concurrent roster creation
        await client.query('SELECT pg_advisory_xact_lock($1)', [leagueId]);

        // Re-check roster count inside transaction
        const currentCount = await this.rosterRepo.getRosterCount(leagueId, client);

        for (let i = currentCount + 1; i <= targetCount; i++) {
          await this.rosterRepo.createEmptyRoster(leagueId, i, client);
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    // Now get ALL rosters (including newly created empty ones)
    const allRosters = await this.rosterRepo.findByLeagueId(leagueId);
    const shuffled = secureShuffleArray(allRosters);

    // Atomically update draft order in a single transaction
    const rosterIds = shuffled.map((r) => r.id);
    await this.draftRepo.updateDraftOrderAtomic(draftId, rosterIds);

    // Update pick asset positions to match new draft order
    if (this.pickAssetRepo) {
      await this.pickAssetRepo.updatePickPositions(draftId);
    }

    // Mark order as confirmed after successful randomization
    await this.draftRepo.setOrderConfirmed(draftId, true);

    // Fetch the final draft order
    const finalOrder = await this.draftRepo.getDraftOrder(draftId);

    // Emit socket event to notify all users viewing the draft room
    const socket = tryGetSocketService();
    socket?.emitDraftSettingsUpdated(draftId, {
      order_confirmed: true,
      draft_order: finalOrder,
    });

    return finalOrder;
  }

  async createInitialOrder(draftId: number, leagueId: number): Promise<void> {
    // Get league to know total roster count
    const league = await this.leagueRepo.findById(leagueId);
    if (!league) {
      return;
    }

    // Get existing rosters
    const existingRosters = await this.rosterRepo.findByLeagueId(leagueId);
    const existingCount = existingRosters.length;
    const targetCount = league.totalRosters;

    // Create empty rosters for unfilled slots (in a transaction)
    if (existingCount < targetCount) {
      const client = await this.db.connect();
      try {
        await client.query('BEGIN');
        // Advisory lock to prevent concurrent roster creation
        await client.query('SELECT pg_advisory_xact_lock($1)', [leagueId]);

        // Re-check roster count inside transaction
        const currentCount = await this.rosterRepo.getRosterCount(leagueId, client);

        for (let i = currentCount + 1; i <= targetCount; i++) {
          await this.rosterRepo.createEmptyRoster(leagueId, i, client);
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    // Now get ALL rosters (including newly created empty ones)
    const allRosters = await this.rosterRepo.findByLeagueId(leagueId);
    if (allRosters.length === 0) {
      return;
    }

    // Use batch insert
    const rosterIds = allRosters.map((r) => r.id);
    await this.draftRepo.updateDraftOrderAtomic(draftId, rosterIds);
  }
}
