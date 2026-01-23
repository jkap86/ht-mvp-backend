import { DraftRepository, QueueEntry } from './drafts.repository';
import { Player } from '../players/players.model';
import { PlayerRepository } from '../players/players.repository';
import { ValidationException } from '../../utils/exceptions';

/**
 * Service for managing draft queues.
 * Centralizes all queue-related business logic that was previously
 * scattered across repository, controller, and autopick service.
 */
export class DraftQueueService {
  constructor(
    private readonly draftRepo: DraftRepository,
    private readonly playerRepo: PlayerRepository
  ) {}

  /**
   * Get a user's queue for a draft
   */
  async getQueue(draftId: number, rosterId: number): Promise<QueueEntry[]> {
    return this.draftRepo.getQueue(draftId, rosterId);
  }

  /**
   * Add a player to a user's queue
   */
  async addToQueue(draftId: number, rosterId: number, playerId: number): Promise<QueueEntry> {
    // Check if player is already drafted
    const isDrafted = await this.draftRepo.isPlayerDrafted(draftId, playerId);
    if (isDrafted) {
      throw new ValidationException('Player has already been drafted');
    }

    return this.draftRepo.addToQueue(draftId, rosterId, playerId);
  }

  /**
   * Remove a player from a user's queue by queue entry ID
   */
  async removeFromQueue(queueId: number): Promise<void> {
    return this.draftRepo.removeFromQueue(queueId);
  }

  /**
   * Remove a player from a user's queue by player ID
   */
  async removeFromQueueByPlayer(draftId: number, rosterId: number, playerId: number): Promise<void> {
    return this.draftRepo.removeFromQueueByPlayer(draftId, rosterId, playerId);
  }

  /**
   * Remove a player from ALL users' queues in a draft
   * (Used when a player is drafted)
   */
  async removePlayerFromAllQueues(draftId: number, playerId: number): Promise<void> {
    return this.draftRepo.removePlayerFromAllQueues(draftId, playerId);
  }

  /**
   * Reorder a user's queue
   */
  async reorderQueue(draftId: number, rosterId: number, playerIds: number[]): Promise<void> {
    return this.draftRepo.reorderQueue(draftId, rosterId, playerIds);
  }

  /**
   * Pick the first available player from queue.
   * Iterates through queue, skipping already-drafted players (and cleaning them up).
   * Returns the first available player, or null if queue is exhausted.
   */
  async pickFirstAvailableFromQueue(
    draftId: number,
    rosterId: number
  ): Promise<{ playerId: number; player: Player | null } | null> {
    const queue = await this.getQueue(draftId, rosterId);
    const draftedPlayerIds = await this.draftRepo.getDraftedPlayerIds(draftId);

    for (const queueItem of queue) {
      if (!draftedPlayerIds.has(queueItem.playerId)) {
        // Found an available player
        const player = await this.playerRepo.findById(queueItem.playerId);
        // Remove from this user's queue (they're picking this player)
        await this.removeFromQueue(queueItem.id);
        return { playerId: queueItem.playerId, player };
      } else {
        // Player already drafted - clean up stale queue entry
        await this.removeFromQueue(queueItem.id);
      }
    }

    return null; // Queue exhausted
  }

  /**
   * Get the best available player (not yet drafted).
   * Uses position priority as ranking.
   */
  async getBestAvailablePlayer(draftId: number): Promise<number | null> {
    return this.draftRepo.getBestAvailablePlayer(draftId);
  }

  /**
   * Clean up all stale queue entries for a user.
   * Removes any queued players that have already been drafted.
   */
  async cleanupStaleEntries(draftId: number, rosterId: number): Promise<number> {
    const queue = await this.getQueue(draftId, rosterId);
    const draftedPlayerIds = await this.draftRepo.getDraftedPlayerIds(draftId);
    let removedCount = 0;

    for (const queueItem of queue) {
      if (draftedPlayerIds.has(queueItem.playerId)) {
        await this.removeFromQueue(queueItem.id);
        removedCount++;
      }
    }

    return removedCount;
  }
}
