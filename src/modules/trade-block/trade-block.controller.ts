import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { TradeBlockService } from './trade-block.service';
import { requireUserId, requireLeagueId } from '../../utils/controller-helpers';
import { tradeBlockItemToResponse } from './trade-block.model';

export class TradeBlockController {
  constructor(private readonly tradeBlockService: TradeBlockService) {}

  getTradeBlock = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);

    const items = await this.tradeBlockService.getByLeague(leagueId, userId);
    res.status(200).json({ items: items.map(tradeBlockItemToResponse) });
  };

  addToTradeBlock = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const { player_id, note } = req.body;

    const item = await this.tradeBlockService.addToTradeBlock(leagueId, userId, player_id, note);
    res.status(201).json(tradeBlockItemToResponse(item));
  };

  removeFromTradeBlock = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const playerId = parseInt(req.params.playerId as string, 10);

    if (isNaN(playerId)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid player ID' } });
    }

    await this.tradeBlockService.removeFromTradeBlock(leagueId, userId, playerId);
    res.status(200).json({ success: true });
  };
}
