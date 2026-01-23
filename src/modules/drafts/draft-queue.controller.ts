import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { DraftQueueService } from './draft-queue.service';
import { DraftRepository } from './drafts.repository';
import { RosterRepository } from '../leagues/leagues.repository';
import { requireUserId, requireLeagueId, requireDraftId, requirePlayerId } from '../../utils/controller-helpers';
import { ForbiddenException, ValidationException, NotFoundException } from '../../utils/exceptions';

export class DraftQueueController {
  constructor(
    private readonly queueService: DraftQueueService,
    private readonly draftRepo: DraftRepository,
    private readonly rosterRepo: RosterRepository
  ) {}

  /**
   * GET /api/leagues/:leagueId/drafts/:draftId/queue
   * Get the current user's queue for this draft
   */
  getQueue = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const draftId = requireDraftId(req);

      // Verify user is in the league
      const roster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
      if (!roster) {
        throw new ForbiddenException('You are not a member of this league');
      }

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
      const playerId = requirePlayerId(req);

      // Verify user is in the league
      const roster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
      if (!roster) {
        throw new ForbiddenException('You are not a member of this league');
      }

      // Verify draft is in progress
      const draft = await this.draftRepo.findById(draftId);
      if (!draft) {
        throw new NotFoundException('Draft not found');
      }
      if (draft.status !== 'in_progress') {
        throw new ValidationException('Cannot modify queue when draft is not in progress');
      }

      // Service handles checking if player is already drafted
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
      const playerIdParam = req.params.playerId as string;
      const playerId = parseInt(playerIdParam, 10);

      if (isNaN(playerId)) {
        throw new ValidationException('Invalid player ID');
      }

      // Verify user is in the league
      const roster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
      if (!roster) {
        throw new ForbiddenException('You are not a member of this league');
      }

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

      // Verify user is in the league
      const roster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
      if (!roster) {
        throw new ForbiddenException('You are not a member of this league');
      }

      // Verify draft is in progress
      const draft = await this.draftRepo.findById(draftId);
      if (!draft) {
        throw new NotFoundException('Draft not found');
      }
      if (draft.status !== 'in_progress') {
        throw new ValidationException('Cannot modify queue when draft is not in progress');
      }

      await this.queueService.reorderQueue(draftId, roster.id, player_ids);
      const queue = await this.queueService.getQueue(draftId, roster.id);
      res.status(200).json(queue);
    } catch (error) {
      next(error);
    }
  };
}
