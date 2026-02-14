import { Router } from 'express';
import { TradeBlockController } from './trade-block.controller';
import { TradeBlockService } from './trade-block.service';
import { authMiddleware } from '../../middleware/auth.middleware';
import { validateRequest } from '../../middleware/validation.middleware';
import { apiReadLimiter, tradeLimiter } from '../../middleware/rate-limit.middleware';
import { addToTradeBlockSchema } from './trade-block.schemas';
import { asyncHandler } from '../../shared/async-handler';
import { container, KEYS } from '../../container';

export function createTradeBlockRoutes(): Router {
  const tradeBlockService = container.resolve<TradeBlockService>(KEYS.TRADE_BLOCK_SERVICE);
  const controller = new TradeBlockController(tradeBlockService);

  const router = Router({ mergeParams: true });

  router.use(authMiddleware);

  // GET /api/leagues/:leagueId/trade-block
  router.get('/', apiReadLimiter, asyncHandler(controller.getTradeBlock));

  // POST /api/leagues/:leagueId/trade-block
  router.post('/', tradeLimiter, validateRequest(addToTradeBlockSchema), asyncHandler(controller.addToTradeBlock));

  // DELETE /api/leagues/:leagueId/trade-block/:playerId
  router.delete('/:playerId', tradeLimiter, asyncHandler(controller.removeFromTradeBlock));

  return router;
}
