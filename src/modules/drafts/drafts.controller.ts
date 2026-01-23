import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { DraftService } from './drafts.service';
import { DraftQueueService } from './draft-queue.service';
import { RosterRepository } from '../leagues/leagues.repository';
import { requireUserId, requireLeagueId, requireDraftId, requirePlayerId } from '../../utils/controller-helpers';
import { ForbiddenException } from '../../utils/exceptions';

export class DraftController {
  constructor(
    private readonly draftService: DraftService,
    private readonly queueService?: DraftQueueService,
    private readonly rosterRepo?: RosterRepository
  ) {}

  getLeagueDrafts = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);

      const drafts = await this.draftService.getLeagueDrafts(leagueId, userId);
      res.status(200).json(drafts);
    } catch (error) {
      next(error);
    }
  };

  getDraft = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const draftId = requireDraftId(req);

      const draft = await this.draftService.getDraftById(leagueId, draftId, userId);
      res.status(200).json(draft);
    } catch (error) {
      next(error);
    }
  };

  createDraft = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);

      const { draft_type, rounds, pick_time_seconds } = req.body;

      const draft = await this.draftService.createDraft(leagueId, userId, {
        draftType: draft_type,
        rounds,
        pickTimeSeconds: pick_time_seconds,
      });
      res.status(201).json(draft);
    } catch (error) {
      next(error);
    }
  };

  getDraftOrder = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const draftId = requireDraftId(req);

      const order = await this.draftService.getDraftOrder(leagueId, draftId, userId);
      res.status(200).json(order);
    } catch (error) {
      next(error);
    }
  };

  randomizeDraftOrder = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const draftId = requireDraftId(req);

      const order = await this.draftService.randomizeDraftOrder(leagueId, draftId, userId);
      res.status(200).json(order);
    } catch (error) {
      next(error);
    }
  };

  startDraft = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const draftId = requireDraftId(req);

      const draft = await this.draftService.startDraft(draftId, userId);
      res.status(200).json(draft);
    } catch (error) {
      next(error);
    }
  };

  performAction = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const draftId = requireDraftId(req);
      const { action, ...params } = req.body;

      let result;
      switch (action) {
        // State actions (commissioner only)
        case 'start':
          result = await this.draftService.startDraft(draftId, userId);
          break;
        case 'pause':
          result = await this.draftService.pauseDraft(draftId, userId);
          break;
        case 'resume':
          result = await this.draftService.resumeDraft(draftId, userId);
          break;
        case 'complete':
          result = await this.draftService.completeDraft(draftId, userId);
          break;

        // Pick action
        case 'pick':
          result = await this.draftService.makePick(leagueId, draftId, userId, params.playerId);
          break;

        // Queue actions
        case 'queue_add':
        case 'queue_remove':
        case 'queue_reorder':
          result = await this.handleQueueAction(draftId, leagueId, userId, action, params);
          break;
      }
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  };

  private handleQueueAction = async (
    draftId: number,
    leagueId: number,
    userId: string,
    action: string,
    params: { playerId?: number; playerIds?: number[] }
  ) => {
    if (!this.queueService || !this.rosterRepo) {
      throw new Error('Queue service not configured');
    }

    const roster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
    if (!roster) {
      throw new ForbiddenException('You are not a member of this league');
    }

    switch (action) {
      case 'queue_add':
        return this.queueService.addToQueue(draftId, roster.id, params.playerId!);
      case 'queue_remove':
        await this.queueService.removeFromQueueByPlayer(draftId, roster.id, params.playerId!);
        return { success: true };
      case 'queue_reorder':
        await this.queueService.reorderQueue(draftId, roster.id, params.playerIds!);
        return { success: true };
    }
  };

  undoPick = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const draftId = requireDraftId(req);

      const result = await this.draftService.undoPick(draftId, userId);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  };

  getDraftPicks = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const draftId = requireDraftId(req);

      const picks = await this.draftService.getDraftPicks(leagueId, draftId, userId);
      res.status(200).json(picks);
    } catch (error) {
      next(error);
    }
  };

  makePick = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const draftId = requireDraftId(req);
      const playerId = requirePlayerId(req);
      const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;

      const pick = await this.draftService.makePick(leagueId, draftId, userId, playerId, idempotencyKey);
      res.status(201).json(pick);
    } catch (error) {
      next(error);
    }
  };

  deleteDraft = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const draftId = requireDraftId(req);

      await this.draftService.deleteDraft(leagueId, draftId, userId);
      res.status(200).json({ message: 'Draft deleted successfully' });
    } catch (error) {
      next(error);
    }
  };
}
