import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { TradesService } from './trades.service';
import { requireUserId, requireLeagueId } from '../../utils/controller-helpers';
import { ValidationException } from '../../utils/exceptions';
import { tradeWithDetailsToResponse } from './trades.model';

export class TradesController {
  constructor(private readonly tradesService: TradesService) {}

  /**
   * GET /api/leagues/:leagueId/trades
   * Get trades for a league
   */
  getTrades = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);

      const statusParam = req.query.status as string | undefined;
      const statuses = statusParam ? statusParam.split(',') : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

      const trades = await this.tradesService.getTradesForLeague(
        leagueId,
        userId,
        statuses,
        limit,
        offset
      );

      res.status(200).json({ trades: trades.map(tradeWithDetailsToResponse) });
    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /api/leagues/:leagueId/trades/:tradeId
   * Get a single trade with details
   */
  getTrade = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const tradeId = parseInt(req.params.tradeId as string, 10);

      if (isNaN(tradeId)) {
        throw new ValidationException('Invalid trade ID');
      }

      const trade = await this.tradesService.getTradeById(tradeId, userId, leagueId);
      res.status(200).json(tradeWithDetailsToResponse(trade));
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /api/leagues/:leagueId/trades
   * Propose a new trade
   */
  proposeTrade = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);

      const {
        recipient_roster_id,
        offering_player_ids,
        requesting_player_ids,
        offering_pick_asset_ids,
        requesting_pick_asset_ids,
        message,
        notify_league_chat,
        notify_dm,
        league_chat_mode,
      } = req.body;

      if (!recipient_roster_id) {
        throw new ValidationException('recipient_roster_id is required');
      }

      if (!Array.isArray(offering_player_ids) || !Array.isArray(requesting_player_ids)) {
        throw new ValidationException(
          'offering_player_ids and requesting_player_ids must be arrays'
        );
      }

      // Validate pick asset IDs are arrays if provided
      if (offering_pick_asset_ids !== undefined && !Array.isArray(offering_pick_asset_ids)) {
        throw new ValidationException('offering_pick_asset_ids must be an array');
      }
      if (requesting_pick_asset_ids !== undefined && !Array.isArray(requesting_pick_asset_ids)) {
        throw new ValidationException('requesting_pick_asset_ids must be an array');
      }

      const trade = await this.tradesService.proposeTrade(leagueId, userId, {
        recipientRosterId: recipient_roster_id,
        offeringPlayerIds: offering_player_ids,
        requestingPlayerIds: requesting_player_ids,
        offeringPickAssetIds: offering_pick_asset_ids,
        requestingPickAssetIds: requesting_pick_asset_ids,
        message,
        notifyLeagueChat: notify_league_chat,
        notifyDm: notify_dm,
        leagueChatMode: league_chat_mode,
      });

      res.status(201).json(tradeWithDetailsToResponse(trade));
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /api/leagues/:leagueId/trades/:tradeId/accept
   * Accept a trade
   */
  acceptTrade = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const tradeId = parseInt(req.params.tradeId as string, 10);

      if (isNaN(tradeId)) {
        throw new ValidationException('Invalid trade ID');
      }

      const trade = await this.tradesService.acceptTrade(tradeId, userId);
      res.status(200).json(tradeWithDetailsToResponse(trade));
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /api/leagues/:leagueId/trades/:tradeId/reject
   * Reject a trade
   */
  rejectTrade = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const tradeId = parseInt(req.params.tradeId as string, 10);

      if (isNaN(tradeId)) {
        throw new ValidationException('Invalid trade ID');
      }

      const trade = await this.tradesService.rejectTrade(tradeId, userId);
      res.status(200).json(tradeWithDetailsToResponse(trade));
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /api/leagues/:leagueId/trades/:tradeId/cancel
   * Cancel a trade (proposer only)
   */
  cancelTrade = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const tradeId = parseInt(req.params.tradeId as string, 10);

      if (isNaN(tradeId)) {
        throw new ValidationException('Invalid trade ID');
      }

      const trade = await this.tradesService.cancelTrade(tradeId, userId);
      res.status(200).json(tradeWithDetailsToResponse(trade));
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /api/leagues/:leagueId/trades/:tradeId/counter
   * Counter a trade
   */
  counterTrade = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const tradeId = parseInt(req.params.tradeId as string, 10);

      if (isNaN(tradeId)) {
        throw new ValidationException('Invalid trade ID');
      }

      const {
        offering_player_ids,
        requesting_player_ids,
        offering_pick_asset_ids,
        requesting_pick_asset_ids,
        message,
        notify_league_chat,
        notify_dm,
        league_chat_mode,
      } = req.body;

      if (!Array.isArray(offering_player_ids) || !Array.isArray(requesting_player_ids)) {
        throw new ValidationException(
          'offering_player_ids and requesting_player_ids must be arrays'
        );
      }

      // Validate pick asset IDs are arrays if provided
      if (offering_pick_asset_ids !== undefined && !Array.isArray(offering_pick_asset_ids)) {
        throw new ValidationException('offering_pick_asset_ids must be an array');
      }
      if (requesting_pick_asset_ids !== undefined && !Array.isArray(requesting_pick_asset_ids)) {
        throw new ValidationException('requesting_pick_asset_ids must be an array');
      }

      const trade = await this.tradesService.counterTrade(tradeId, userId, {
        offeringPlayerIds: offering_player_ids,
        requestingPlayerIds: requesting_player_ids,
        offeringPickAssetIds: offering_pick_asset_ids,
        requestingPickAssetIds: requesting_pick_asset_ids,
        message,
        notifyDm: notify_dm,
        leagueChatMode: league_chat_mode,
      });

      res.status(201).json(tradeWithDetailsToResponse(trade));
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /api/leagues/:leagueId/trades/:tradeId/vote
   * Vote on a trade
   */
  voteTrade = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const tradeId = parseInt(req.params.tradeId as string, 10);

      if (isNaN(tradeId)) {
        throw new ValidationException('Invalid trade ID');
      }

      const { vote } = req.body;

      if (vote !== 'approve' && vote !== 'veto') {
        throw new ValidationException('vote must be "approve" or "veto"');
      }

      const result = await this.tradesService.voteTrade(tradeId, userId, vote);

      res.status(200).json({
        trade: tradeWithDetailsToResponse(result.trade),
        vote_count: result.voteCount,
      });
    } catch (error) {
      next(error);
    }
  };
}
