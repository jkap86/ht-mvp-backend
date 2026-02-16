import { Router } from 'express';
import { TradesController } from './trades.controller';
import { TradesService } from './trades.service';
import { authMiddleware } from '../../middleware/auth.middleware';
import { validateRequest } from '../../middleware/validation.middleware';
import { apiReadLimiter, tradeLimiter } from '../../middleware/rate-limit.middleware';
import { container, KEYS } from '../../container';
import { proposeTradeSchema, counterTradeSchema, voteTradeSchema } from './trades.schemas';
import { asyncHandler } from '../../shared/async-handler';
import { resolveSeasonContext } from '../../middleware/season-context.middleware';
import { seasonWriteGuard } from '../../middleware/season-write-guard.middleware';

// Resolve dependencies from container
const tradesService = container.resolve<TradesService>(KEYS.TRADES_SERVICE);

// Create controller instance
const tradesController = new TradesController(tradesService);

const router = Router({ mergeParams: true }); // mergeParams to access :leagueId

// All trade routes require authentication and season context
router.use(authMiddleware);
router.use(resolveSeasonContext);
router.use(seasonWriteGuard);

/**
 * GET /api/leagues/:leagueId/trades
 * Get trades for a league with optional status filter
 * Query params: ?status=pending,accepted&limit=50&offset=0
 */
router.get('/', apiReadLimiter, asyncHandler(tradesController.getTrades));

/**
 * GET /api/leagues/:leagueId/trades/:tradeId
 * Get a single trade with full details
 */
router.get('/:tradeId', apiReadLimiter, asyncHandler(tradesController.getTrade));

/**
 * POST /api/leagues/:leagueId/trades
 * Propose a new trade
 * Body: { recipient_roster_id, offering_player_ids[], requesting_player_ids[], message? }
 */
router.post('/', tradeLimiter, validateRequest(proposeTradeSchema), asyncHandler(tradesController.proposeTrade));

/**
 * POST /api/leagues/:leagueId/trades/:tradeId/accept
 * Accept a pending trade (recipient only)
 */
router.post('/:tradeId/accept', tradeLimiter, asyncHandler(tradesController.acceptTrade));

/**
 * POST /api/leagues/:leagueId/trades/:tradeId/reject
 * Reject a pending trade (recipient only)
 */
router.post('/:tradeId/reject', tradeLimiter, asyncHandler(tradesController.rejectTrade));

/**
 * POST /api/leagues/:leagueId/trades/:tradeId/cancel
 * Cancel a pending trade (proposer only)
 */
router.post('/:tradeId/cancel', tradeLimiter, asyncHandler(tradesController.cancelTrade));

/**
 * POST /api/leagues/:leagueId/trades/:tradeId/counter
 * Counter a trade with a new offer
 * Body: { offering_player_ids[], requesting_player_ids[], message? }
 */
router.post(
  '/:tradeId/counter',
  tradeLimiter,
  validateRequest(counterTradeSchema),
  asyncHandler(tradesController.counterTrade)
);

/**
 * POST /api/leagues/:leagueId/trades/:tradeId/vote
 * Vote on a trade during review period
 * Body: { vote: 'approve' | 'veto' }
 */
router.post('/:tradeId/vote', tradeLimiter, validateRequest(voteTradeSchema), asyncHandler(tradesController.voteTrade));

export default router;
