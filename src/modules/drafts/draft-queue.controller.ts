import { Response, NextFunction } from 'express';
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
  getQueue = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const draftId = requireDraftId(req);

      const roster = await this.queueService.resolveUserRoster(leagueId, userId);
      const queue = await this.queueService.getQueue(draftId, roster.id);
      res.status(200).json(queue);
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /api/leagues/:leagueId/drafts/:draftId/queue
   * Add a player to the current user's queue
   * Body: { player_id: number }
   */
  addToQueue = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const draftId = requireDraftId(req);
      const playerId = req.body.player_id;

      const roster = await this.queueService.resolveUserRoster(leagueId, userId);
      await this.queueService.requireDraftInProgress(draftId);
      const entry = await this.queueService.addToQueue(draftId, roster.id, playerId);
      res.status(201).json(entry);
    } catch (error) {
      next(error);
    }
  };

  /**
   * DELETE /api/leagues/:leagueId/drafts/:draftId/queue/:playerId
   * Remove a player from the current user's queue
   */
  removeFromQueue = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
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
    } catch (error) {
      next(error);
    }
  };

  /**
   * PUT /api/leagues/:leagueId/drafts/:draftId/queue
   * Reorder the current user's queue
   * Body: { player_ids: number[] }
   */
  reorderQueue = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const draftId = requireDraftId(req);
      const { player_ids } = req.body;

      if (!Array.isArray(player_ids)) {
        throw new ValidationException('player_ids must be an array');
      }

      const roster = await this.queueService.resolveUserRoster(leagueId, userId);
      await this.queueService.requireDraftInProgress(draftId);
      await this.queueService.reorderQueue(draftId, roster.id, player_ids);
      const queue = await this.queueService.getQueue(draftId, roster.id);
      res.status(200).json(queue);
    } catch (error) {
      next(error);
    }
  };
}
