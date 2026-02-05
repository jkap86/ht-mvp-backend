import { DraftRepository, QueueEntry } from './drafts.repository';
import { Player } from '../players/players.model';
import { PlayerRepository } from '../players/players.repository';
import { RosterRepository } from '../leagues/leagues.repository';
import { Roster } from '../leagues/leagues.model';
import { ValidationException, ForbiddenException, NotFoundException } from '../../utils/exceptions';

/**
 * Service for managing draft queues.
 * Centralizes all queue-related business logic that was previously
 * scattered across repository, controller, and autopick service.
 */
export class DraftQueueService {
  constructor(
    private readonly draftRepo: DraftRepository,
    private readonly playerRepo: PlayerRepository,
    private readonly rosterRepo: RosterRepository
  ) {}

  /**
   * Resolve user's roster in a league. Throws if not a member.
   */
  async resolveUserRoster(leagueId: number, userId: string): Promise<Roster> {
    const roster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
    if (!roster) {
      throw new ForbiddenException('You are not a member of this league');
    }
    return roster;
  }

  /**
   * Validate draft is in progress. Throws if not.
   */
  async requireDraftInProgress(draftId: number): Promise<void> {
    const draft = await this.draftRepo.findById(draftId);
    if (!draft) {
      throw new NotFoundException('Draft not found');
    }
    if (draft.status !== 'in_progress') {
      throw new ValidationException('Cannot modify queue when draft is not in progress');
    }
  }

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
   * Add a pick asset to a user's queue
   */
  async addPickAssetToQueue(
    draftId: number,
    rosterId: number,
    pickAssetId: number
  ): Promise<QueueEntry> {
    // Check if pick asset is already drafted (selected in vet_draft_pick_selections)
    // This is validated at the repository level during insert
    return this.draftRepo.addToQueue(draftId, rosterId, undefined, pickAssetId);
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
  async removeFromQueueByPlayer(
    draftId: number,
    rosterId: number,
    playerId: number
  ): Promise<void> {
    return this.draftRepo.removeFromQueueByPlayer(draftId, rosterId, playerId);
  }

  /**
   * Remove a pick asset from a user's queue
   */
  async removeFromQueueByPickAsset(
    draftId: number,
    rosterId: number,
    pickAssetId: number
  ): Promise<void> {
    return this.draftRepo.removeFromQueueByPickAsset(draftId, rosterId, pickAssetId);
  }

  /**
   * Remove a player from ALL users' queues in a draft
   * (Used when a player is drafted)
   */
  async removePlayerFromAllQueues(draftId: number, playerId: number): Promise<void> {
    return this.draftRepo.removePlayerFromAllQueues(draftId, playerId);
  }

  /**
   * Remove a pick asset from ALL users' queues in a draft
   * (Used when a pick asset is drafted)
   */
  async removePickAssetFromAllQueues(draftId: number, pickAssetId: number): Promise<void> {
    return this.draftRepo.removePickAssetFromAllQueues(draftId, pickAssetId);
  }

  /**
   * Reorder a user's queue
   * @param entryIds - Optional array of queue entry IDs (for mixed player + pick asset queues)
   * @param playerIds - Legacy array of player IDs (for backwards compatibility)
   */
  async reorderQueue(
    draftId: number,
    rosterId: number,
    playerIds: number[],
    entryIds?: number[]
  ): Promise<void> {
    return this.draftRepo.reorderQueue(draftId, rosterId, playerIds, entryIds);
  }

  /**
   * Pick the first available item from queue (player or pick asset).
   * Iterates through queue, skipping already-drafted items (and cleaning them up).
   * Returns the first available item, or null if queue is exhausted.
   */
  async pickFirstAvailableFromQueue(
    draftId: number,
    rosterId: number,
    draftedPickAssetIds?: Set<number>
  ): Promise<
    | { type: 'player'; playerId: number; player: Player | null }
    | { type: 'pickAsset'; pickAssetId: number }
    | null
  > {
    const queue = await this.getQueue(draftId, rosterId);
    const draftedPlayerIds = await this.draftRepo.getDraftedPlayerIds(draftId);

    for (const queueItem of queue) {
      if (queueItem.playerId !== null) {
        // Player entry
        if (!draftedPlayerIds.has(queueItem.playerId)) {
          // Found an available player
          const player = await this.playerRepo.findById(queueItem.playerId);
          // Remove from this user's queue (they're picking this player)
          await this.removeFromQueue(queueItem.id);
          return { type: 'player', playerId: queueItem.playerId, player };
        } else {
          // Player already drafted - clean up stale queue entry
          await this.removeFromQueue(queueItem.id);
        }
      } else if (queueItem.pickAssetId !== null) {
        // Pick asset entry
        if (!draftedPickAssetIds || !draftedPickAssetIds.has(queueItem.pickAssetId)) {
          // Found an available pick asset
          // Remove from this user's queue
          await this.removeFromQueue(queueItem.id);
          return { type: 'pickAsset', pickAssetId: queueItem.pickAssetId };
        } else {
          // Pick asset already drafted - clean up stale queue entry
          await this.removeFromQueue(queueItem.id);
        }
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
   * Removes any queued players or pick assets that have already been drafted.
   */
  async cleanupStaleEntries(
    draftId: number,
    rosterId: number,
    draftedPickAssetIds?: Set<number>
  ): Promise<number> {
    const queue = await this.getQueue(draftId, rosterId);
    const draftedPlayerIds = await this.draftRepo.getDraftedPlayerIds(draftId);
    let removedCount = 0;

    for (const queueItem of queue) {
      if (queueItem.playerId !== null && draftedPlayerIds.has(queueItem.playerId)) {
        await this.removeFromQueue(queueItem.id);
        removedCount++;
      } else if (
        queueItem.pickAssetId !== null &&
        draftedPickAssetIds &&
        draftedPickAssetIds.has(queueItem.pickAssetId)
      ) {
        await this.removeFromQueue(queueItem.id);
        removedCount++;
      }
    }

    return removedCount;
  }
}
