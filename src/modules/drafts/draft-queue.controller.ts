import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { DraftQueueService } from './draft-queue.service';
import { requireUserId, requireLeagueId, requireDraftId } from '../../utils/controller-helpers';
import { ValidationException } from '../../utils/exceptions';

export class DraftQueueController {
  constructor(private readonly queueService: DraftQueueService) {}

  /**
   * GET /api/leagues/:leagueId/drafts/:draftId/queue
   * Get the current user's queue for this draft
   */
  getQueue = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const draftId = requireDraftId(req);

    const roster = await this.queueService.resolveUserRoster(leagueId, userId);
    const queue = await this.queueService.getQueue(draftId, roster.id);
    res.status(200).json(queue);
  };

  /**
   * POST /api/leagues/:leagueId/drafts/:draftId/queue
   * Add a player or pick asset to the current user's queue
   * Body: { player_id: number } OR { pick_asset_id: number }
   */
  addToQueue = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const draftId = requireDraftId(req);
    const playerId = req.body.player_id;
    const pickAssetId = req.body.pick_asset_id;

    if (!playerId && !pickAssetId) {
      throw new ValidationException('Either player_id or pick_asset_id is required');
    }
    if (playerId && pickAssetId) {
      throw new ValidationException('Cannot provide both player_id and pick_asset_id');
    }

    const roster = await this.queueService.resolveUserRoster(leagueId, userId);
    await this.queueService.requireDraftInProgress(draftId);

    let entry;
    if (playerId) {
      entry = await this.queueService.addToQueue(draftId, roster.id, playerId);
    } else {
      entry = await this.queueService.addPickAssetToQueue(draftId, roster.id, pickAssetId);
    }
    res.status(201).json(entry);
  };

  /**
   * DELETE /api/leagues/:leagueId/drafts/:draftId/queue/:playerId
   * Remove a player from the current user's queue
   */
  removeFromQueue = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const draftId = requireDraftId(req);
    const playerId = parseInt(req.params.playerId as string, 10);

    if (isNaN(playerId)) {
      throw new ValidationException('Invalid player ID');
    }

    const roster = await this.queueService.resolveUserRoster(leagueId, userId);
    await this.queueService.removeFromQueueByPlayer(draftId, roster.id, playerId);
    res.status(200).json({ message: 'Player removed from queue' });
  };

  /**
   * DELETE /api/leagues/:leagueId/drafts/:draftId/queue/pick-asset/:pickAssetId
   * Remove a pick asset from the current user's queue
   */
  removePickAssetFromQueue = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const draftId = requireDraftId(req);
    const pickAssetId = parseInt(req.params.pickAssetId as string, 10);

    if (isNaN(pickAssetId)) {
      throw new ValidationException('Invalid pick asset ID');
    }

    const roster = await this.queueService.resolveUserRoster(leagueId, userId);
    await this.queueService.removeFromQueueByPickAsset(draftId, roster.id, pickAssetId);
    res.status(200).json({ message: 'Pick asset removed from queue' });
  };

  /**
   * PUT /api/leagues/:leagueId/drafts/:draftId/queue
   * Reorder the current user's queue
   * Body: { player_ids: number[] } OR { queue_entry_ids: number[] }
   */
  reorderQueue = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const draftId = requireDraftId(req);
    const { player_ids, queue_entry_ids } = req.body;

    // Accept either queue_entry_ids (new) or player_ids (legacy)
    if (!Array.isArray(queue_entry_ids) && !Array.isArray(player_ids)) {
      throw new ValidationException('Either queue_entry_ids or player_ids must be an array');
    }

    const roster = await this.queueService.resolveUserRoster(leagueId, userId);
    await this.queueService.requireDraftInProgress(draftId);
    await this.queueService.reorderQueue(
      draftId,
      roster.id,
      player_ids || [],
      queue_entry_ids
    );
    const queue = await this.queueService.getQueue(draftId, roster.id);
    res.status(200).json(queue);
  };
}
