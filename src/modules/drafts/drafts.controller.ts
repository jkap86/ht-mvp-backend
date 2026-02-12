import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { DraftService } from './drafts.service';
import { DraftQueueService } from './draft-queue.service';
import { SlowAuctionService } from './auction/slow-auction.service';
import { AuthorizationService } from '../auth/authorization.service';
import {
  requireUserId,
  requireLeagueId,
  requireDraftId,
  requirePlayerId,
} from '../../utils/controller-helpers';
import { ValidationException } from '../../utils/exceptions';
import { ActionDispatcher } from './action-handlers';
import { auctionLotToResponse, auctionBidHistoryToResponse } from './auction/auction.models';

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

  getLeagueDrafts = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);

    const drafts = await this.draftService.getLeagueDrafts(leagueId, userId);
    res.status(200).json(drafts);
  };

  getDraft = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const draftId = requireDraftId(req);

    const draft = await this.draftService.getDraftById(leagueId, draftId, userId);
    res.status(200).json(draft);
  };

  createDraft = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);

    const {
      draft_type,
      rounds,
      pick_time_seconds,
      auction_settings,
      player_pool,
      scheduled_start,
      include_rookie_picks,
      rookie_picks_season,
      rookie_picks_rounds,
    } = req.body;

    const draft = await this.draftService.createDraft(leagueId, userId, {
      draftType: draft_type,
      rounds,
      pickTimeSeconds: pick_time_seconds,
      auctionSettings: auction_settings,
      playerPool: player_pool,
      scheduledStart: scheduled_start ? new Date(scheduled_start) : undefined,
      includeRookiePicks: include_rookie_picks,
      rookiePicksSeason: rookie_picks_season,
      rookiePicksRounds: rookie_picks_rounds,
    });
    res.status(201).json(draft);
  };

  getDraftConfig = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);

    const config = await this.draftService.getDraftConfig(leagueId, userId);
    res.status(200).json(config);
  };

  getDraftOrder = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const draftId = requireDraftId(req);

    const order = await this.draftService.getDraftOrder(leagueId, draftId, userId);
    res.status(200).json(order);
  };

  randomizeDraftOrder = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const draftId = requireDraftId(req);
    const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;

    const order = await this.draftService.randomizeDraftOrder(leagueId, draftId, userId, idempotencyKey);
    res.status(200).json(order);
  };

  confirmDraftOrder = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const draftId = requireDraftId(req);
    const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;

    const order = await this.draftService.confirmDraftOrder(leagueId, draftId, userId, idempotencyKey);
    res.status(200).json(order);
  };

  setOrderFromPickOwnership = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const draftId = requireDraftId(req);

    const order = await this.draftService.setOrderFromPickOwnership(leagueId, draftId, userId);
    res.status(200).json(order);
  };

  startDraft = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const draftId = requireDraftId(req);
    const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;

    const draft = await this.draftService.startDraft(draftId, userId, idempotencyKey);
    res.status(200).json(draft);
  };

  performAction = async (req: AuthRequest, res: Response) => {
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
  };

  undoPick = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const draftId = requireDraftId(req);

    const result = await this.draftService.undoPick(leagueId, draftId, userId);
    res.status(200).json(result);
  };

  getDraftPicks = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const draftId = requireDraftId(req);

    const picks = await this.draftService.getDraftPicks(leagueId, draftId, userId);
    res.status(200).json(picks);
  };

  getAvailablePickAssets = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const draftId = requireDraftId(req);

    const assets = await this.draftService.getAvailablePickAssets(leagueId, draftId, userId);
    res.status(200).json({ pick_assets: assets });
  };

  getAuctionLots = async (req: AuthRequest, res: Response) => {
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
  };

  getAuctionLot = async (req: AuthRequest, res: Response) => {
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
  };

  getLotBidHistory = async (req: AuthRequest, res: Response) => {
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
    await this.authService.ensureLeagueMember(leagueId, userId);

    if (!this.slowAuctionService) {
      throw new ValidationException('Auction service not available');
    }

    const history = await this.slowAuctionService.getBidHistoryWithUsernames(draftId, lotId);
    res.status(200).json({ history: history.map(auctionBidHistoryToResponse) });
  };

  getAuctionBudgets = async (req: AuthRequest, res: Response) => {
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
  };

  getAuctionState = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const draftId = requireDraftId(req);

    // Verify user is league member and get their roster
    if (!this.authService) {
      throw new ValidationException('Authorization service not available');
    }
    const roster = await this.authService.ensureLeagueMember(leagueId, userId);

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

    // Get active lot(s) with user's max bids included
    if (!this.slowAuctionService) {
      throw new ValidationException('Auction service not available');
    }
    const lots = await this.slowAuctionService.getActiveLotsWithUserBids(draftId, roster.id);
    const activeLot = lots.length > 0 ? auctionLotToResponse(lots[0]) : null;

    // Get budgets
    const budgets = await this.slowAuctionService.getAllBudgets(draftId);

    // Get nomination stats for slow auctions
    const nominationStats =
      auctionMode === 'slow'
        ? await this.slowAuctionService.getNominationStats(draftId, roster.id)
        : null;

    // Build response with snake_case conversion
    const state = {
      auction_mode: auctionMode,
      active_lot: activeLot,
      active_lots: lots.map(auctionLotToResponse), // Includes my_max_bid for each lot
      current_nominator_roster_id: auctionMode === 'fast' ? draft.currentRosterId : null,
      nomination_number: auctionMode === 'fast' ? draft.currentPick : null,
      nomination_deadline: auctionMode === 'fast' ? draft.pickDeadline : null,
      settings: {
        auction_mode: auctionSettings.auctionMode,
        bid_window_seconds: auctionSettings.bidWindowSeconds,
        max_active_nominations_per_team: auctionSettings.maxActiveNominationsPerTeam,
        max_active_nominations_global: draft.settings?.maxActiveNominationsGlobal ?? 25,
        daily_nomination_limit: draft.settings?.dailyNominationLimit ?? null,
        nomination_seconds: auctionSettings.nominationSeconds,
        reset_on_bid_seconds: auctionSettings.resetOnBidSeconds,
        min_bid: auctionSettings.minBid,
        min_increment: auctionSettings.minIncrement,
      },
      budgets: budgets.map(budgetToResponse),
      // Nomination stats for slow auctions
      nomination_stats: nominationStats
        ? {
            daily_nominations_used: nominationStats.dailyNominationsUsed,
            daily_nomination_limit: nominationStats.dailyNominationLimit,
            daily_nominations_remaining: nominationStats.dailyNominationsRemaining,
            total_active_lots: nominationStats.totalActiveLots,
            global_active_limit: nominationStats.globalActiveLimit,
            global_cap_reached: nominationStats.globalCapReached,
          }
        : null,
    };

    res.status(200).json(state);
  };

  makePick = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const draftId = requireDraftId(req);
    const playerId = requirePlayerId(req);
    const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;

    const pick = await this.draftService.makePick(
      leagueId,
      draftId,
      userId,
      playerId,
      idempotencyKey
    );
    res.status(201).json(pick);
  };

  deleteDraft = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const draftId = requireDraftId(req);

    await this.draftService.deleteDraft(leagueId, draftId, userId);
    res.status(200).json({ message: 'Draft deleted successfully' });
  };

  toggleAutodraft = async (req: AuthRequest, res: Response) => {
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
  };

  updateDraftSettings = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const draftId = requireDraftId(req);

    const {
      draft_type,
      rounds,
      pick_time_seconds,
      auction_settings,
      player_pool,
      scheduled_start,
      include_rookie_picks,
      rookie_picks_season,
      rookie_picks_rounds,
      overnight_pause_enabled,
      overnight_pause_start,
      overnight_pause_end,
    } = req.body;

    // Handle scheduled_start: parse date string, or pass null to clear it
    let scheduledStart: Date | null | undefined;
    if (scheduled_start === null) {
      scheduledStart = null;
    } else if (scheduled_start !== undefined) {
      scheduledStart = new Date(scheduled_start);
    }

    const draft = await this.draftService.updateDraftSettings(leagueId, draftId, userId, {
      draftType: draft_type,
      rounds,
      pickTimeSeconds: pick_time_seconds,
      auctionSettings: auction_settings,
      playerPool: player_pool,
      scheduledStart,
      includeRookiePicks: include_rookie_picks,
      rookiePicksSeason: rookie_picks_season,
      rookiePicksRounds: rookie_picks_rounds,
      overnightPauseEnabled: overnight_pause_enabled,
      overnightPauseStart: overnight_pause_start,
      overnightPauseEnd: overnight_pause_end,
    });

    res.status(200).json(draft);
  };

  /**
   * Get available matchup options for the current picker in a matchups draft
   */
  getAvailableMatchups = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const draftId = requireDraftId(req);

    const matchups = await this.draftService.getAvailableMatchups(leagueId, draftId, userId);
    res.status(200).json({
      draft_id: draftId,
      available_matchups: matchups,
    });
  };

  /**
   * Make a matchup pick in a matchups draft
   */
  pickMatchup = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const draftId = requireDraftId(req);

    const { week, opponent_roster_id } = req.body;

    if (!week || !opponent_roster_id) {
      throw new ValidationException('week and opponent_roster_id are required');
    }

    const result = await this.draftService.makeMatchupPick(
      leagueId,
      draftId,
      userId,
      week,
      opponent_roster_id
    );

    res.status(200).json(result);
  };
}
