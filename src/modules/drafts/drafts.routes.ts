import { Router } from 'express';
import { DraftController } from './drafts.controller';
import { DraftQueueController } from './draft-queue.controller';
import { DerbyController } from './derby/derby.controller';
import { DraftService } from './drafts.service';
import { DraftQueueService } from './draft-queue.service';
import { DerbyService } from './derby/derby.service';
import { SlowAuctionService } from './auction/slow-auction.service';
import { FastAuctionService } from './auction/fast-auction.service';
import { RosterRepository } from '../leagues/leagues.repository';
import { AuthorizationService } from '../auth/authorization.service';
import { authMiddleware } from '../../middleware/auth.middleware';
import { validateRequest } from '../../middleware/validation.middleware';
import {
  draftPickLimiter,
  queueLimiter,
  draftModifyLimiter,
  apiReadLimiter,
} from '../../middleware/rate-limit.middleware';
import { container, KEYS } from '../../container';
import {
  createDraftSchema,
  updateDraftSettingsSchema,
  makePickSchema,
  addToQueueSchema,
  reorderQueueSchema,
  draftActionSchema,
} from './drafts.schemas';
import { ActionDispatcher } from './action-handlers';
import { StateActionHandler } from './action-handlers/state.handler';
import { PickActionHandler } from './action-handlers/pick.handler';
import { QueueActionHandler } from './action-handlers/queue.handler';
import { AuctionActionHandler } from './action-handlers/auction.handler';
import { asyncHandler } from '../../shared/async-handler';
import { resolveSeasonContext } from '../../middleware/season-context.middleware';
import { seasonWriteGuard } from '../../middleware/season-write-guard.middleware';
import { idempotencyMiddleware } from '../../middleware/idempotency.middleware';
import { Pool } from 'pg';

// Resolve dependencies from container
const draftService = container.resolve<DraftService>(KEYS.DRAFT_SERVICE);
const queueService = container.resolve<DraftQueueService>(KEYS.DRAFT_QUEUE_SERVICE);
const rosterRepo = container.resolve<RosterRepository>(KEYS.ROSTER_REPO);
const authService = container.resolve<AuthorizationService>(KEYS.AUTHORIZATION_SERVICE);
const slowAuctionService = container.resolve<SlowAuctionService>(KEYS.SLOW_AUCTION_SERVICE);
const fastAuctionService = container.resolve<FastAuctionService>(KEYS.FAST_AUCTION_SERVICE);
const derbyService = container.resolve<DerbyService>(KEYS.DERBY_SERVICE);

// Set up action dispatcher with all handlers
const actionDispatcher = new ActionDispatcher();
actionDispatcher.register(new StateActionHandler(draftService));
actionDispatcher.register(new PickActionHandler(draftService));
actionDispatcher.register(new QueueActionHandler(queueService, rosterRepo));
actionDispatcher.register(
  new AuctionActionHandler(slowAuctionService, fastAuctionService, rosterRepo)
);

// Draft controller with dispatcher for unified /actions endpoint
const draftController = new DraftController(
  draftService,
  queueService,
  authService,
  slowAuctionService,
  actionDispatcher
);

// Queue controller uses service layer only
const queueController = new DraftQueueController(queueService);

// Derby controller
const derbyController = new DerbyController(derbyService);

const router = Router({ mergeParams: true }); // mergeParams to access :leagueId

// All draft routes require authentication and season context
router.use(authMiddleware);
router.use(resolveSeasonContext);
router.use(seasonWriteGuard);
router.use(idempotencyMiddleware(container.resolve<Pool>(KEYS.POOL)));

// GET /api/leagues/:leagueId/drafts
router.get('/', apiReadLimiter, asyncHandler(draftController.getLeagueDrafts));

// GET /api/leagues/:leagueId/drafts/config (draft configuration options and defaults)
router.get('/config', apiReadLimiter, asyncHandler(draftController.getDraftConfig));

// POST /api/leagues/:leagueId/drafts
router.post(
  '/',
  draftModifyLimiter,
  validateRequest(createDraftSchema),
  asyncHandler(draftController.createDraft)
);

// GET /api/leagues/:leagueId/drafts/:draftId
router.get('/:draftId', apiReadLimiter, asyncHandler(draftController.getDraft));

// PATCH /api/leagues/:leagueId/drafts/:draftId/settings (commissioner only)
router.patch(
  '/:draftId/settings',
  draftModifyLimiter,
  validateRequest(updateDraftSettingsSchema),
  asyncHandler(draftController.updateDraftSettings)
);

// DELETE /api/leagues/:leagueId/drafts/:draftId
router.delete('/:draftId', draftModifyLimiter, asyncHandler(draftController.deleteDraft));

// GET /api/leagues/:leagueId/drafts/:draftId/order
router.get('/:draftId/order', apiReadLimiter, asyncHandler(draftController.getDraftOrder));

// POST /api/leagues/:leagueId/drafts/:draftId/randomize
router.post('/:draftId/randomize', draftModifyLimiter, asyncHandler(draftController.randomizeDraftOrder));

// POST /api/leagues/:leagueId/drafts/:draftId/order/confirm
router.post('/:draftId/order/confirm', draftModifyLimiter, asyncHandler(draftController.confirmDraftOrder));

// POST /api/leagues/:leagueId/drafts/:draftId/order/from-pick-ownership
// Sets draft order based on Round 1 pick ownership from vet draft selections
router.post('/:draftId/order/from-pick-ownership', draftModifyLimiter, asyncHandler(draftController.setOrderFromPickOwnership));

// POST /api/leagues/:leagueId/drafts/:draftId/start
router.post('/:draftId/start', draftModifyLimiter, asyncHandler(draftController.startDraft));

// POST /api/leagues/:leagueId/drafts/:draftId/actions (unified action endpoint)
router.post(
  '/:draftId/actions',
  draftModifyLimiter,
  validateRequest(draftActionSchema),
  asyncHandler(draftController.performAction)
);

// POST /api/leagues/:leagueId/drafts/:draftId/undo (commissioner undo last pick)
router.post('/:draftId/undo', draftModifyLimiter, asyncHandler(draftController.undoPick));

// GET /api/leagues/:leagueId/drafts/:draftId/picks
router.get('/:draftId/picks', apiReadLimiter, asyncHandler(draftController.getDraftPicks));

// GET /api/leagues/:leagueId/drafts/:draftId/available-pick-assets
router.get('/:draftId/available-pick-assets', apiReadLimiter, asyncHandler(draftController.getAvailablePickAssets));

// POST /api/leagues/:leagueId/drafts/:draftId/pick
router.post(
  '/:draftId/pick',
  draftPickLimiter,
  validateRequest(makePickSchema),
  asyncHandler(draftController.makePick)
);

// GET /api/leagues/:leagueId/drafts/:draftId/chess-clocks
router.get('/:draftId/chess-clocks', apiReadLimiter, asyncHandler(draftController.getChessClocks));

// GET /api/leagues/:leagueId/drafts/:draftId/auction/state
router.get('/:draftId/auction/state', apiReadLimiter, asyncHandler(draftController.getAuctionState));

// GET /api/leagues/:leagueId/drafts/:draftId/auction/lots
router.get('/:draftId/auction/lots', apiReadLimiter, asyncHandler(draftController.getAuctionLots));

// GET /api/leagues/:leagueId/drafts/:draftId/auction/lots/:lotId
router.get('/:draftId/auction/lots/:lotId', apiReadLimiter, asyncHandler(draftController.getAuctionLot));

// GET /api/leagues/:leagueId/drafts/:draftId/auction/lots/:lotId/history
router.get('/:draftId/auction/lots/:lotId/history', apiReadLimiter, asyncHandler(draftController.getLotBidHistory));

// GET /api/leagues/:leagueId/drafts/:draftId/auction/budgets
router.get('/:draftId/auction/budgets', apiReadLimiter, asyncHandler(draftController.getAuctionBudgets));

// Queue routes
// GET /api/leagues/:leagueId/drafts/:draftId/queue
router.get('/:draftId/queue', apiReadLimiter, asyncHandler(queueController.getQueue));

// POST /api/leagues/:leagueId/drafts/:draftId/queue
router.post(
  '/:draftId/queue',
  queueLimiter,
  validateRequest(addToQueueSchema),
  asyncHandler(queueController.addToQueue)
);

// PUT /api/leagues/:leagueId/drafts/:draftId/queue (reorder)
router.put(
  '/:draftId/queue',
  queueLimiter,
  validateRequest(reorderQueueSchema),
  asyncHandler(queueController.reorderQueue)
);

// DELETE /api/leagues/:leagueId/drafts/:draftId/queue/:playerId
router.delete('/:draftId/queue/:playerId', queueLimiter, asyncHandler(queueController.removeFromQueue));

// DELETE /api/leagues/:leagueId/drafts/:draftId/queue/pick-asset/:pickAssetId
router.delete('/:draftId/queue/pick-asset/:pickAssetId', queueLimiter, asyncHandler(queueController.removePickAssetFromQueue));

// PATCH /api/leagues/:leagueId/drafts/:draftId/autodraft
router.patch('/:draftId/autodraft', draftModifyLimiter, asyncHandler(draftController.toggleAutodraft));

// Derby routes (draft order selection phase)
// POST /api/leagues/:leagueId/drafts/:draftId/derby/start
router.post('/:draftId/derby/start', draftModifyLimiter, asyncHandler(derbyController.startDerby));

// POST /api/leagues/:leagueId/drafts/:draftId/derby/pick-slot
router.post('/:draftId/derby/pick-slot', draftPickLimiter, asyncHandler(derbyController.pickSlot));

// GET /api/leagues/:leagueId/drafts/:draftId/derby/state
router.get('/:draftId/derby/state', apiReadLimiter, asyncHandler(derbyController.getDerbyState));

// Matchups draft routes
// GET /api/leagues/:leagueId/drafts/:draftId/available-matchups
router.get('/:draftId/available-matchups', apiReadLimiter, asyncHandler(draftController.getAvailableMatchups));

// POST /api/leagues/:leagueId/drafts/:draftId/pick-matchup
router.post('/:draftId/pick-matchup', draftPickLimiter, asyncHandler(draftController.pickMatchup));

export default router;
