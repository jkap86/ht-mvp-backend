import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { DraftService } from './drafts.service';
import { requireUserId, requireLeagueId, requireDraftId, requirePlayerId } from '../../utils/controller-helpers';

export class DraftController {
  constructor(private readonly draftService: DraftService) {}

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
      const draftId = requireDraftId(req);
      const { action } = req.body;

      let draft;
      switch (action) {
        case 'start':
          draft = await this.draftService.startDraft(draftId, userId);
          break;
        case 'pause':
          draft = await this.draftService.pauseDraft(draftId, userId);
          break;
        case 'resume':
          draft = await this.draftService.resumeDraft(draftId, userId);
          break;
        case 'complete':
          draft = await this.draftService.completeDraft(draftId, userId);
          break;
      }
      res.status(200).json(draft);
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
