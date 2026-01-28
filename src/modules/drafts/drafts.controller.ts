import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { DraftService } from './drafts.service';
import { DraftQueueService } from './draft-queue.service';
import { SlowAuctionService } from './auction/slow-auction.service';
import { AuthorizationService } from '../auth/authorization.service';
import { requireUserId, requireLeagueId, requireDraftId, requirePlayerId } from '../../utils/controller-helpers';
import { ValidationException } from '../../utils/exceptions';
import { ActionDispatcher } from './action-handlers';
import { auctionLotToResponse } from './auction/auction.models';

/**
 * Convert budget to snake_case for API response
 */
function budgetToResponse(budget: {
  rosterId: number;
  username: string;
  totalBudget: number;
  spent: number;
  leadingCommitment: number;
  available: number;
  wonCount: number;
}): Record<string, any> {
  return {
    roster_id: budget.rosterId,
    username: budget.username,
    total_budget: budget.totalBudget,
    spent: budget.spent,
    leading_commitment: budget.leadingCommitment,
    available: budget.available,
    won_count: budget.wonCount,
  };
}

export class DraftController {
  private actionDispatcher?: ActionDispatcher;

  constructor(
    private readonly draftService: DraftService,
    private readonly queueService?: DraftQueueService,
    private readonly authService?: AuthorizationService,
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
      if (!this.authService) {
        throw new ValidationException('Authorization service not available');
      }
      await this.authService.ensureLeagueMember(leagueId, userId);

      // Get status filter from query (supports: active, won, passed, all)
      const status = req.query.status as string | undefined;

      if (!this.slowAuctionService) {
        throw new ValidationException('Auction service not available');
      }

      // Use status filter if provided, otherwise default to active lots
      const lots = status
        ? await this.slowAuctionService.getLotsByStatus(draftId, status)
        : await this.slowAuctionService.getActiveLots(draftId);
      res.status(200).json({ lots: lots.map(auctionLotToResponse) });
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

      if (!this.authService) {
        throw new ValidationException('Authorization service not available');
      }
      const roster = await this.authService.ensureLeagueMember(leagueId, userId);

      if (!this.slowAuctionService) {
        throw new ValidationException('Auction service not available');
      }

      const lot = await this.slowAuctionService.getLotById(draftId, lotId);
      const userProxyBid = await this.slowAuctionService.getUserProxyBid(lotId, roster.id);

      res.status(200).json({ lot: lot ? auctionLotToResponse(lot) : null, userProxyBid });
    } catch (error) {
      next(error);
    }
  };

  getAuctionBudgets = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const draftId = requireDraftId(req);

      if (!this.authService) {
        throw new ValidationException('Authorization service not available');
      }
      await this.authService.ensureLeagueMember(leagueId, userId);

      if (!this.slowAuctionService) {
        throw new ValidationException('Auction service not available');
      }

      const budgets = await this.slowAuctionService.getAllBudgets(draftId);
      res.status(200).json({ budgets: budgets.map(budgetToResponse) });
    } catch (error) {
      next(error);
    }
  };

  getAuctionState = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const draftId = requireDraftId(req);

      // Verify user is league member
      if (!this.authService) {
        throw new ValidationException('Authorization service not available');
      }
      await this.authService.ensureLeagueMember(leagueId, userId);

      // Get draft to determine auction mode
      const draft = await this.draftService.getDraftById(leagueId, draftId, userId);
      // Settings are stored flat on draft.settings, not nested under auctionSettings
      const auctionMode = draft.settings?.auctionMode || 'slow';

      // Build normalized settings object for response
      const auctionSettings = {
        auctionMode,
        bidWindowSeconds: draft.settings?.bidWindowSeconds ?? 43200,
        maxActiveNominationsPerTeam: draft.settings?.maxActiveNominationsPerTeam ?? 2,
        nominationSeconds: draft.settings?.nominationSeconds ?? 45,
        resetOnBidSeconds: draft.settings?.resetOnBidSeconds ?? 10,
        minBid: draft.settings?.minBid ?? 1,
        minIncrement: draft.settings?.minIncrement ?? 1,
      };

      // Get active lot(s) - for fast auction, there's at most one
      if (!this.slowAuctionService) {
        throw new ValidationException('Auction service not available');
      }
      const lots = await this.slowAuctionService.getActiveLots(draftId);
      const activeLot = lots.length > 0 ? auctionLotToResponse(lots[0]) : null;

      // Get budgets
      const budgets = await this.slowAuctionService.getAllBudgets(draftId);

      // Build response with snake_case conversion
      const state = {
        auction_mode: auctionMode,
        active_lot: activeLot,
        active_lots: lots.map(auctionLotToResponse), // Include all for slow auction
        current_nominator_roster_id: auctionMode === 'fast' ? draft.currentRosterId : null,
        nomination_number: auctionMode === 'fast' ? draft.currentPick : null,
        settings: {
          auction_mode: auctionSettings.auctionMode,
          bid_window_seconds: auctionSettings.bidWindowSeconds,
          max_active_nominations_per_team: auctionSettings.maxActiveNominationsPerTeam,
          nomination_seconds: auctionSettings.nominationSeconds,
          reset_on_bid_seconds: auctionSettings.resetOnBidSeconds,
          min_bid: auctionSettings.minBid,
          min_increment: auctionSettings.minIncrement,
        },
        budgets: budgets.map(budgetToResponse),
      };

      res.status(200).json(state);
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

  toggleAutodraft = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const draftId = requireDraftId(req);
      const { enabled } = req.body;

      if (typeof enabled !== 'boolean') {
        throw new ValidationException('enabled must be a boolean');
      }

      const result = await this.draftService.toggleAutodraft(leagueId, draftId, userId, enabled);
      res.status(200).json({
        roster_id: result.rosterId,
        enabled: result.enabled,
      });
    } catch (error) {
      next(error);
    }
  };
}
