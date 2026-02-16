import { randomBytes } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { DraftRepository } from './drafts.repository';
import { DraftPickAssetRepository } from './draft-pick-asset.repository';
import type { LeagueRepository, RosterRepository } from '../leagues/leagues.repository';
import { ForbiddenException, ValidationException } from '../../utils/exceptions';
import { EventTypes, tryGetEventBus } from '../../shared/events';
import { runWithLock, LockDomain } from '../../shared/transaction-runner';

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

  async randomizeDraftOrder(leagueId: number, draftId: number, userId: string, idempotencyKey?: string): Promise<any[]> {
    // Idempotency check: return existing result if same key was already used
    if (idempotencyKey) {
      const existing = await this.db.query(
        `SELECT result FROM draft_operations
         WHERE idempotency_key = $1 AND user_id = $2 AND operation_type = 'randomize'
         AND expires_at > NOW()`,
        [idempotencyKey, userId]
      );
      if (existing.rows.length > 0) {
        return existing.rows[0].result;
      }
    }

    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can randomize draft order');
    }

    const draft = await this.draftRepo.findById(draftId);
    if (!draft || draft.status !== 'not_started') {
      throw new ValidationException('Can only randomize order before draft starts');
    }

    // All roster reads, order updates, and confirmations must happen inside the lock
    // to prevent concurrent join/leave from corrupting draft order
    const finalOrder = await runWithLock(this.db, LockDomain.LEAGUE, leagueId, async (client) => {
      // Get ALL rosters for the league
      const allRosters = await this.rosterRepo.findByLeagueIdWithClient(client, leagueId);

      // Partition: real users vs empty placeholders
      const realRosters = allRosters.filter((r: { userId?: string | null }) => r.userId != null);
      const emptyRosters = allRosters.filter((r: { userId?: string | null }) => r.userId == null);

      // Shuffle only real-user rosters
      const shuffledReal = secureShuffleArray(realRosters);

      // Combined order: shuffled real rosters first, then empty placeholders
      const orderedRosters = [...shuffledReal, ...emptyRosters];
      const rosterIds = orderedRosters.map((r: { id: number }) => r.id);

      await this.draftRepo.updateDraftOrderAtomicWithClient(client, draftId, rosterIds);

      // Update pick asset positions to match new draft order
      if (this.pickAssetRepo) {
        await this.pickAssetRepo.updatePickPositions(draftId, client);
      }

      // Mark order as confirmed after successful randomization
      await this.draftRepo.setOrderConfirmed(draftId, true, client);

      // Fetch the final draft order within the transaction
      const order = await this.draftRepo.getDraftOrderWithClient(client, draftId);

      // Store result for idempotency inside the transaction
      if (idempotencyKey) {
        await client.query(
          `INSERT INTO draft_operations (idempotency_key, draft_id, user_id, operation_type, result)
           VALUES ($1, $2, $3, 'randomize', $4)
           ON CONFLICT (idempotency_key, user_id, operation_type) DO NOTHING`,
          [idempotencyKey, draftId, userId, JSON.stringify(order)]
        );
      }

      return order;
    });

    // Emit event AFTER transaction commits
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.DRAFT_ORDER_UPDATED,
      payload: {
        draftId,
        order_confirmed: true,
        draft_order: finalOrder,
      },
    });

    return finalOrder;
  }

  /**
   * Confirm the draft order without randomizing.
   * Commissioner can use this to confirm a manually arranged order.
   */
  async confirmDraftOrder(leagueId: number, draftId: number, userId: string, idempotencyKey?: string): Promise<any[]> {
    // Idempotency check: return existing result if same key was already used
    if (idempotencyKey) {
      const existing = await this.db.query(
        `SELECT result FROM draft_operations
         WHERE idempotency_key = $1 AND user_id = $2 AND operation_type = 'confirm'
         AND expires_at > NOW()`,
        [idempotencyKey, userId]
      );
      if (existing.rows.length > 0) {
        return existing.rows[0].result;
      }
    }

    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can confirm draft order');
    }

    const draft = await this.draftRepo.findById(draftId);
    if (!draft || draft.status !== 'not_started') {
      throw new ValidationException('Can only confirm order before draft starts');
    }

    if (draft.orderConfirmed) {
      // Already confirmed - this is idempotent, return current order
      const draftOrder = await this.draftRepo.getDraftOrder(draftId);
      return draftOrder;
    }

    // Verify draft order exists and is valid
    const draftOrder = await this.draftRepo.getDraftOrder(draftId);
    if (draftOrder.length === 0) {
      throw new ValidationException('Draft order not set');
    }

    // Update pick asset positions to match current draft order
    if (this.pickAssetRepo) {
      await this.pickAssetRepo.updatePickPositions(draftId);
    }

    // Mark order as confirmed
    await this.draftRepo.setOrderConfirmed(draftId, true);

    // Emit event to notify all users viewing the draft room
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.DRAFT_ORDER_UPDATED,
      payload: {
        draftId,
        order_confirmed: true,
        draft_order: draftOrder,
      },
    });

    // Store result for idempotency
    if (idempotencyKey) {
      await this.db.query(
        `INSERT INTO draft_operations (idempotency_key, draft_id, user_id, operation_type, result)
         VALUES ($1, $2, $3, 'confirm', $4)
         ON CONFLICT (idempotency_key, user_id, operation_type) DO NOTHING`,
        [idempotencyKey, draftId, userId, JSON.stringify(draftOrder)]
      );
    }

    return draftOrder;
  }

  /**
   * Set draft order based on Round 1 pick ownership from existing pick assets.
   * Used when a rookie draft is created after a vet draft distributed the picks.
   */
  async setOrderFromPickOwnership(
    leagueId: number,
    draftId: number,
    userId: string
  ): Promise<any[]> {
    const isCommissioner = await this.leagueRepo.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can set draft order');
    }

    const draft = await this.draftRepo.findById(draftId);
    if (!draft || draft.status !== 'not_started') {
      throw new ValidationException('Can only set order before draft starts');
    }

    // Get Round 1 ownership order
    if (!this.pickAssetRepo) {
      throw new ValidationException('Pick asset repository not available');
    }

    // Get the season from pick assets linked to this draft
    const pickAssets = await this.pickAssetRepo.findByDraftId(draftId);
    if (pickAssets.length === 0) {
      throw new ValidationException('No pick assets linked to this draft. Cannot use vet draft results.');
    }
    const season = pickAssets[0].season;

    const rosterIds = await this.pickAssetRepo.getRound1OwnershipOrder(leagueId, season);
    if (rosterIds.length === 0) {
      throw new ValidationException('No Round 1 pick assets found for this season.');
    }

    // Update draft order based on pick ownership
    await this.draftRepo.updateDraftOrderAtomic(draftId, rosterIds);

    // Update pick asset positions to match new draft order
    await this.pickAssetRepo.updatePickPositions(draftId);

    // Mark order as confirmed
    await this.draftRepo.setOrderConfirmed(draftId, true);

    // Fetch the final draft order
    const finalOrder = await this.draftRepo.getDraftOrder(draftId);

    // Emit event to notify all users viewing the draft room
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.DRAFT_ORDER_UPDATED,
      payload: {
        draftId,
        order_confirmed: true,
        draft_order: finalOrder,
      },
    });

    return finalOrder;
  }

  async createInitialOrder(draftId: number, leagueId: number): Promise<void> {
    // All operations must happen inside the lock to prevent concurrent join/leave
    // from corrupting draft order
    await runWithLock(this.db, LockDomain.LEAGUE, leagueId, async (client) => {
      // Get ALL rosters for the league
      const allRosters = await this.rosterRepo.findByLeagueIdWithClient(client, leagueId);
      if (allRosters.length === 0) {
        return;
      }

      // Partition: real users first (by roster_id), then empty placeholders
      const realRosters = allRosters.filter((r) => r.userId != null);
      const emptyRosters = allRosters.filter((r) => r.userId == null);
      const orderedRosters = [...realRosters, ...emptyRosters];

      // Use batch insert within the transaction
      const rosterIds = orderedRosters.map((r: { id: number }) => r.id);
      await this.draftRepo.updateDraftOrderAtomicWithClient(client, draftId, rosterIds);
    });
  }

  /**
   * Create initial draft order within an existing transaction.
   * Used during league creation to keep draft setup atomic with league creation.
   */
  async createInitialOrderWithClient(
    client: PoolClient,
    draftId: number,
    leagueId: number,
    _totalRosters: number
  ): Promise<void> {
    // Get ALL rosters for the league
    const allRosters = await this.rosterRepo.findByLeagueIdWithClient(client, leagueId);
    if (allRosters.length === 0) {
      return;
    }

    // Partition: real users first (by roster_id), then empty placeholders
    const realRosters = allRosters.filter((r) => r.userId != null);
    const emptyRosters = allRosters.filter((r) => r.userId == null);
    const orderedRosters = [...realRosters, ...emptyRosters];

    // Use batch insert within the transaction
    const rosterIds = orderedRosters.map((r: { id: number }) => r.id);
    await this.draftRepo.updateDraftOrderAtomicWithClient(client, draftId, rosterIds);
  }
}
