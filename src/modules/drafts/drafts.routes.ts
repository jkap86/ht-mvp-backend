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

// All draft routes require authentication
router.use(authMiddleware);

// GET /api/leagues/:leagueId/drafts
router.get('/', apiReadLimiter, draftController.getLeagueDrafts);

// GET /api/leagues/:leagueId/drafts/config (draft configuration options and defaults)
router.get('/config', apiReadLimiter, draftController.getDraftConfig);

// POST /api/leagues/:leagueId/drafts
router.post(
  '/',
  draftModifyLimiter,
  validateRequest(createDraftSchema),
  draftController.createDraft
);

// GET /api/leagues/:leagueId/drafts/:draftId
router.get('/:draftId', apiReadLimiter, draftController.getDraft);

// PATCH /api/leagues/:leagueId/drafts/:draftId/settings (commissioner only)
router.patch(
  '/:draftId/settings',
  draftModifyLimiter,
  validateRequest(updateDraftSettingsSchema),
  draftController.updateDraftSettings
);

// DELETE /api/leagues/:leagueId/drafts/:draftId
router.delete('/:draftId', draftController.deleteDraft);

// GET /api/leagues/:leagueId/drafts/:draftId/order
router.get('/:draftId/order', apiReadLimiter, draftController.getDraftOrder);

// POST /api/leagues/:leagueId/drafts/:draftId/randomize
router.post('/:draftId/randomize', draftModifyLimiter, draftController.randomizeDraftOrder);

// POST /api/leagues/:leagueId/drafts/:draftId/order/confirm
router.post('/:draftId/order/confirm', draftModifyLimiter, draftController.confirmDraftOrder);

// POST /api/leagues/:leagueId/drafts/:draftId/order/from-pick-ownership
// Sets draft order based on Round 1 pick ownership from vet draft selections
router.post('/:draftId/order/from-pick-ownership', draftModifyLimiter, draftController.setOrderFromPickOwnership);

// POST /api/leagues/:leagueId/drafts/:draftId/start
router.post('/:draftId/start', draftModifyLimiter, draftController.startDraft);

// POST /api/leagues/:leagueId/drafts/:draftId/actions (unified action endpoint)
router.post(
  '/:draftId/actions',
  draftModifyLimiter,
  validateRequest(draftActionSchema),
  draftController.performAction
);

// POST /api/leagues/:leagueId/drafts/:draftId/undo (commissioner undo last pick)
router.post('/:draftId/undo', draftModifyLimiter, draftController.undoPick);

// GET /api/leagues/:leagueId/drafts/:draftId/picks
router.get('/:draftId/picks', apiReadLimiter, draftController.getDraftPicks);

// GET /api/leagues/:leagueId/drafts/:draftId/available-pick-assets
router.get('/:draftId/available-pick-assets', apiReadLimiter, draftController.getAvailablePickAssets);

// POST /api/leagues/:leagueId/drafts/:draftId/pick
router.post(
  '/:draftId/pick',
  draftPickLimiter,
  validateRequest(makePickSchema),
  draftController.makePick
);

// GET /api/leagues/:leagueId/drafts/:draftId/auction/state
router.get('/:draftId/auction/state', apiReadLimiter, draftController.getAuctionState);

// GET /api/leagues/:leagueId/drafts/:draftId/auction/lots
router.get('/:draftId/auction/lots', apiReadLimiter, draftController.getAuctionLots);

// GET /api/leagues/:leagueId/drafts/:draftId/auction/lots/:lotId
router.get('/:draftId/auction/lots/:lotId', apiReadLimiter, draftController.getAuctionLot);

// GET /api/leagues/:leagueId/drafts/:draftId/auction/lots/:lotId/history
router.get('/:draftId/auction/lots/:lotId/history', apiReadLimiter, draftController.getLotBidHistory);

// GET /api/leagues/:leagueId/drafts/:draftId/auction/budgets
router.get('/:draftId/auction/budgets', apiReadLimiter, draftController.getAuctionBudgets);

// Queue routes
// GET /api/leagues/:leagueId/drafts/:draftId/queue
router.get('/:draftId/queue', apiReadLimiter, queueController.getQueue);

// POST /api/leagues/:leagueId/drafts/:draftId/queue
router.post(
  '/:draftId/queue',
  queueLimiter,
  validateRequest(addToQueueSchema),
  queueController.addToQueue
);

// PUT /api/leagues/:leagueId/drafts/:draftId/queue (reorder)
router.put(
  '/:draftId/queue',
  queueLimiter,
  validateRequest(reorderQueueSchema),
  queueController.reorderQueue
);

// DELETE /api/leagues/:leagueId/drafts/:draftId/queue/:playerId
router.delete('/:draftId/queue/:playerId', queueLimiter, queueController.removeFromQueue);

// DELETE /api/leagues/:leagueId/drafts/:draftId/queue/pick-asset/:pickAssetId
router.delete('/:draftId/queue/pick-asset/:pickAssetId', queueLimiter, queueController.removePickAssetFromQueue);

// PATCH /api/leagues/:leagueId/drafts/:draftId/autodraft
router.patch('/:draftId/autodraft', draftController.toggleAutodraft);

// Derby routes (draft order selection phase)
// POST /api/leagues/:leagueId/drafts/:draftId/derby/start
router.post('/:draftId/derby/start', draftModifyLimiter, derbyController.startDerby);

// POST /api/leagues/:leagueId/drafts/:draftId/derby/pick-slot
router.post('/:draftId/derby/pick-slot', draftPickLimiter, derbyController.pickSlot);

// GET /api/leagues/:leagueId/drafts/:draftId/derby/state
router.get('/:draftId/derby/state', apiReadLimiter, derbyController.getDerbyState);

export default router;
