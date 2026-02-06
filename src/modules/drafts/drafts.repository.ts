/**
 * Draft Repository (Facade)
 *
 * This file serves as a backward-compatible facade that delegates to
 * the split repository classes:
 * - DraftCoreRepository: Core CRUD operations
 * - DraftOrderRepository: Draft order management
 * - DraftPickRepository: Pick operations and atomic transactions
 * - DraftQueueRepository: Queue management
 *
 * For new code, prefer importing from ./repositories directly.
 */

import { Pool, PoolClient } from 'pg';
import { Draft, DraftOrderEntry, DraftPick, DraftSettings } from './drafts.model';
import { DraftCoreRepository } from './repositories/draft-core.repository';
import { DraftOrderRepository } from './repositories/draft-order.repository';
import { DraftPickRepository } from './repositories/draft-pick.repository';
import { DraftQueueRepository, type QueueEntry } from './repositories/draft-queue.repository';

export class DraftRepository {
  private readonly core: DraftCoreRepository;
  private readonly order: DraftOrderRepository;
  private readonly pick: DraftPickRepository;
  private readonly queue: DraftQueueRepository;

  constructor(private readonly db: Pool) {
    this.core = new DraftCoreRepository(db);
    this.order = new DraftOrderRepository(db);
    this.pick = new DraftPickRepository(db);
    this.queue = new DraftQueueRepository(db);
  }

  // ============================================
  // Core Draft Operations (delegated to DraftCoreRepository)
  // ============================================

  async findById(id: number): Promise<Draft | null> {
    return this.core.findById(id);
  }

  async findByIdWithClient(client: PoolClient, id: number): Promise<Draft | null> {
    return this.core.findByIdWithClient(client, id);
  }

  async findByLeagueId(leagueId: number): Promise<Draft[]> {
    return this.core.findByLeagueId(leagueId);
  }

  async findByLeagueIdWithMembershipCheck(
    leagueId: number,
    userId: string
  ): Promise<Draft[] | null> {
    return this.core.findByLeagueIdWithMembershipCheck(leagueId, userId);
  }

  async create(
    leagueId: number,
    draftType: string,
    rounds: number,
    pickTimeSeconds: number,
    settings?: DraftSettings | Record<string, any>,
    scheduledStart?: Date
  ): Promise<Draft> {
    return this.core.create(leagueId, draftType, rounds, pickTimeSeconds, settings, scheduledStart);
  }

  async update(id: number, updates: Partial<Draft>): Promise<Draft> {
    return this.core.update(id, updates);
  }

  async updateWithLock(
    id: number,
    updates: Partial<Draft>,
    expectedStatus?: string
  ): Promise<Draft> {
    return this.core.updateWithLock(id, updates, expectedStatus);
  }

  async delete(id: number): Promise<void> {
    return this.core.delete(id);
  }

  async setOrderConfirmed(draftId: number, confirmed: boolean): Promise<void> {
    return this.core.setOrderConfirmed(draftId, confirmed);
  }

  async findExpiredDrafts(): Promise<Draft[]> {
    return this.core.findExpiredDrafts();
  }

  async getBestAvailablePlayer(
    draftId: number,
    playerPool: string[] = ['veteran', 'rookie']
  ): Promise<number | null> {
    return this.core.getBestAvailablePlayer(draftId, playerPool);
  }

  // ============================================
  // Draft Order Operations (delegated to DraftOrderRepository)
  // ============================================

  async getDraftOrder(
    draftId: number,
    limit?: number,
    offset?: number
  ): Promise<DraftOrderEntry[]> {
    return this.order.getDraftOrder(draftId, limit, offset);
  }

  async setAutodraftEnabled(draftId: number, rosterId: number, enabled: boolean): Promise<void> {
    return this.order.setAutodraftEnabled(draftId, rosterId, enabled);
  }

  async getAutodraftEnabled(draftId: number, rosterId: number): Promise<boolean> {
    return this.order.getAutodraftEnabled(draftId, rosterId);
  }

  async createDraftOrder(draftId: number, rosterId: number, position: number): Promise<void> {
    return this.order.createDraftOrder(draftId, rosterId, position);
  }

  async clearDraftOrder(draftId: number): Promise<void> {
    return this.order.clearDraftOrder(draftId);
  }

  async updateDraftOrderAtomic(draftId: number, rosterIds: number[]): Promise<void> {
    return this.order.updateDraftOrderAtomic(draftId, rosterIds);
  }

  // ============================================
  // Draft Pick Operations (delegated to DraftPickRepository)
  // ============================================

  async getDraftPicks(draftId: number, limit?: number, offset?: number): Promise<DraftPick[]> {
    return this.pick.getDraftPicks(draftId, limit, offset);
  }

  async createDraftPick(
    draftId: number,
    pickNumber: number,
    round: number,
    pickInRound: number,
    rosterId: number,
    playerId: number
  ): Promise<DraftPick> {
    return this.pick.createDraftPick(draftId, pickNumber, round, pickInRound, rosterId, playerId);
  }

  async createDraftPickWithCleanup(
    draftId: number,
    pickNumber: number,
    round: number,
    pickInRound: number,
    rosterId: number,
    playerId: number,
    idempotencyKey?: string
  ): Promise<DraftPick> {
    return this.pick.createDraftPickWithCleanup(
      draftId,
      pickNumber,
      round,
      pickInRound,
      rosterId,
      playerId,
      idempotencyKey
    );
  }

  async undoLastPick(draftId: number): Promise<DraftPick | null> {
    return this.pick.undoLastPick(draftId);
  }

  async isPlayerDrafted(draftId: number, playerId: number): Promise<boolean> {
    return this.pick.isPlayerDrafted(draftId, playerId);
  }

  async getDraftedPlayerIds(draftId: number): Promise<Set<number>> {
    return this.pick.getDraftedPlayerIds(draftId);
  }

  async markPickAsAutoPick(pickId: number): Promise<void> {
    return this.pick.markPickAsAutoPick(pickId);
  }

  async pickExists(draftId: number, pickNumber: number): Promise<boolean> {
    return this.pick.pickExists(draftId, pickNumber);
  }

  async pickExistsWithClient(
    client: PoolClient,
    draftId: number,
    pickNumber: number
  ): Promise<boolean> {
    return this.pick.pickExistsWithClient(client, draftId, pickNumber);
  }

  async makePickAndAdvanceTx(params: {
    draftId: number;
    expectedPickNumber: number;
    round: number;
    pickInRound: number;
    rosterId: number;
    playerId: number;
    nextPickState: {
      currentPick: number | null;
      currentRound: number | null;
      currentRosterId: number | null;
      pickDeadline: Date | null;
      status?: 'in_progress' | 'completed';
      completedAt?: Date | null;
    };
    idempotencyKey?: string;
    isAutoPick?: boolean;
  }): Promise<{ pick: DraftPick; draft: Draft }> {
    return this.pick.makePickAndAdvanceTx(params);
  }

  async makePickAssetSelectionTx(params: {
    draftId: number;
    expectedPickNumber: number;
    draftPickAssetId: number;
    rosterId: number;
    nextPickState: {
      currentPick: number | null;
      currentRound: number | null;
      currentRosterId: number | null;
      pickDeadline: Date | null;
      status?: 'in_progress' | 'completed';
      completedAt?: Date | null;
    };
    idempotencyKey?: string;
  }): Promise<{
    selectionId: number;
    selectedAt: Date;
    draft: Draft;
  }> {
    return this.pick.makePickAssetSelectionTx(params);
  }

  async undoLastPickTx(params: {
    draftId: number;
    prevPickState: {
      currentPick: number;
      currentRound: number;
      currentRosterId: number | null;
      pickDeadline: Date | null;
      status: 'in_progress' | 'paused';
      completedAt: null;
    };
    includeRookiePicks?: boolean;
  }): Promise<{
    undonePick: DraftPick | null;
    undoneSelection?: { id: number; draftPickAssetId: number; pickNumber: number; rosterId: number } | null;
    draft: Draft;
  }> {
    return this.pick.undoLastPickTx(params);
  }

  // ============================================
  // Draft Queue Operations (delegated to DraftQueueRepository)
  // ============================================

  async getQueue(draftId: number, rosterId: number): Promise<QueueEntry[]> {
    return this.queue.getQueue(draftId, rosterId);
  }

  async addToQueue(
    draftId: number,
    rosterId: number,
    playerId?: number,
    pickAssetId?: number
  ): Promise<QueueEntry> {
    return this.queue.addToQueue(draftId, rosterId, playerId, pickAssetId);
  }

  async removeFromQueue(queueId: number): Promise<void> {
    return this.queue.removeFromQueue(queueId);
  }

  async removeFromQueueByPlayer(
    draftId: number,
    rosterId: number,
    playerId: number
  ): Promise<void> {
    return this.queue.removeFromQueueByPlayer(draftId, rosterId, playerId);
  }

  async removePlayerFromAllQueues(draftId: number, playerId: number): Promise<void> {
    return this.queue.removePlayerFromAllQueues(draftId, playerId);
  }

  async removeFromQueueByPickAsset(
    draftId: number,
    rosterId: number,
    pickAssetId: number
  ): Promise<void> {
    return this.queue.removeFromQueueByPickAsset(draftId, rosterId, pickAssetId);
  }

  async removePickAssetFromAllQueues(draftId: number, pickAssetId: number): Promise<void> {
    return this.queue.removePickAssetFromAllQueues(draftId, pickAssetId);
  }

  async reorderQueue(
    draftId: number,
    rosterId: number,
    playerIds: number[],
    entryIds?: number[]
  ): Promise<void> {
    return this.queue.reorderQueue(draftId, rosterId, playerIds, entryIds);
  }
}

// Re-export QueueEntry for backward compatibility
export type { QueueEntry } from './repositories/draft-queue.repository';
