import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { DraftService } from './drafts.service';
import { DraftQueueService } from './draft-queue.service';
import { SlowAuctionService } from './auction/slow-auction.service';
import { RosterRepository } from '../leagues/leagues.repository';
import { requireUserId, requireLeagueId, requireDraftId, requirePlayerId } from '../../utils/controller-helpers';
import { ForbiddenException, ValidationException } from '../../utils/exceptions';
import { ActionDispatcher } from './action-handlers';

export class DraftController {
  private actionDispatcher?: ActionDispatcher;

  constructor(
    private readonly draftService: DraftService,
    private readonly queueService?: DraftQueueService,
    private readonly rosterRepo?: RosterRepository,
    private readonly slowAuctionService?: SlowAuctionService,
    actionDispatcher?: ActionDispatcher
  ) {
    this.actionDispatcher = actionDispatcher;
  }

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

      const { draft_type, rounds, pick_time_seconds, auction_settings } = req.body;

      const draft = await this.draftService.createDraft(leagueId, userId, {
        draftType: draft_type,
        rounds,
        pickTimeSeconds: pick_time_seconds,
        auctionSettings: auction_settings,
      });
      res.status(201).json(draft);
    } catch (error) {
      next(error);
    }
  };

  getDraftConfig = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);

      const config = await this.draftService.getDraftConfig(leagueId, userId);
      res.status(200).json(config);
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

      if (!this.actionDispatcher) {
        throw new ValidationException('Action dispatcher not configured');
      }

      const result = await this.actionDispatcher.dispatch(
        { userId, leagueId, draftId },
        action,
        params
      );

      res.status(200).json(result);
    } catch (error) {
      next(error);
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

  getAuctionLots = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const draftId = requireDraftId(req);

      // Verify user is a member of the league
      if (!this.rosterRepo) {
        throw new ValidationException('Roster repository not available');
      }
      const roster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
      if (!roster) {
        throw new ForbiddenException('You are not a member of this league');
      }

      // Get status filter from query (default to 'active')
      const status = req.query.status as string | undefined;

      // For now, use the lotRepo through slowAuctionService or add a method
      // Since we need to access the repository, we'll need to inject it or use a service method
      if (!this.slowAuctionService) {
        throw new ValidationException('Auction service not available');
      }

      // We need to add a method to get lots - for now let's add getActiveLots to the service
      const lots = await this.slowAuctionService.getActiveLots(draftId);
      res.status(200).json({ lots });
    } catch (error) {
      next(error);
    }
  };

  getAuctionLot = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const draftId = requireDraftId(req);
      const lotId = parseInt(req.params.lotId as string, 10);

      if (isNaN(lotId)) {
        throw new ValidationException('Invalid lot ID');
      }

      if (!this.rosterRepo) {
        throw new ValidationException('Roster repository not available');
      }
      const roster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
      if (!roster) {
        throw new ForbiddenException('You are not a member of this league');
      }

      if (!this.slowAuctionService) {
        throw new ValidationException('Auction service not available');
      }

      const lot = await this.slowAuctionService.getLotById(draftId, lotId);
      const userProxyBid = await this.slowAuctionService.getUserProxyBid(lotId, roster.id);

      res.status(200).json({ lot, userProxyBid });
    } catch (error) {
      next(error);
    }
  };

  getAuctionBudgets = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const draftId = requireDraftId(req);

      if (!this.rosterRepo) {
        throw new ValidationException('Roster repository not available');
      }
      const roster = await this.rosterRepo.findByLeagueAndUser(leagueId, userId);
      if (!roster) {
        throw new ForbiddenException('You are not a member of this league');
      }

      if (!this.slowAuctionService) {
        throw new ValidationException('Auction service not available');
      }

      const budgets = await this.slowAuctionService.getAllBudgets(draftId);
      res.status(200).json({ budgets });
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
