import { Router } from 'express';
import { TradesController } from './trades.controller';
import { TradesService } from './trades.service';
import { authMiddleware } from '../../middleware/auth.middleware';
import { validateRequest } from '../../middleware/validation.middleware';
import { container, KEYS } from '../../container';
import { proposeTradeSchema, counterTradeSchema, voteTradeSchema } from './trades.schemas';

// Resolve dependencies from container
const tradesService = container.resolve<TradesService>(KEYS.TRADES_SERVICE);

// Create controller instance
const tradesController = new TradesController(tradesService);

const router = Router({ mergeParams: true }); // mergeParams to access :leagueId

// All trade routes require authentication
router.use(authMiddleware);

/**
 * GET /api/leagues/:leagueId/trades
 * Get trades for a league with optional status filter
 * Query params: ?status=pending,accepted&limit=50&offset=0
 */
router.get('/', tradesController.getTrades);

/**
 * GET /api/leagues/:leagueId/trades/:tradeId
 * Get a single trade with full details
 */
router.get('/:tradeId', tradesController.getTrade);

/**
 * POST /api/leagues/:leagueId/trades
 * Propose a new trade
 * Body: { recipient_roster_id, offering_player_ids[], requesting_player_ids[], message? }
 */
router.post('/', validateRequest(proposeTradeSchema), tradesController.proposeTrade);

/**
 * POST /api/leagues/:leagueId/trades/:tradeId/accept
 * Accept a pending trade (recipient only)
 */
router.post('/:tradeId/accept', tradesController.acceptTrade);

/**
 * POST /api/leagues/:leagueId/trades/:tradeId/reject
 * Reject a pending trade (recipient only)
 */
router.post('/:tradeId/reject', tradesController.rejectTrade);

/**
 * POST /api/leagues/:leagueId/trades/:tradeId/cancel
 * Cancel a pending trade (proposer only)
 */
router.post('/:tradeId/cancel', tradesController.cancelTrade);

/**
 * POST /api/leagues/:leagueId/trades/:tradeId/counter
 * Counter a trade with a new offer
 * Body: { offering_player_ids[], requesting_player_ids[], message? }
 */
router.post(
  '/:tradeId/counter',
  validateRequest(counterTradeSchema),
  tradesController.counterTrade
);

/**
 * POST /api/leagues/:leagueId/trades/:tradeId/vote
 * Vote on a trade during review period
 * Body: { vote: 'approve' | 'veto' }
 */
router.post('/:tradeId/vote', validateRequest(voteTradeSchema), tradesController.voteTrade);

export default router;
