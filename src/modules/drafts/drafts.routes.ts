import { Router } from 'express';
import { DraftController } from './drafts.controller';
import { DraftQueueController } from './draft-queue.controller';
import { DraftService } from './drafts.service';
import { DraftQueueService } from './draft-queue.service';
import { RosterRepository } from '../leagues/leagues.repository';
import { authMiddleware } from '../../middleware/auth.middleware';
import { validateRequest } from '../../middleware/validation.middleware';
import { draftPickLimiter, queueLimiter, draftModifyLimiter } from '../../middleware/rate-limit.middleware';
import { container, KEYS } from '../../container';
import {
  createDraftSchema,
  makePickSchema,
  addToQueueSchema,
  reorderQueueSchema,
  draftActionSchema,
} from './drafts.schemas';

// Resolve dependencies from container
const draftService = container.resolve<DraftService>(KEYS.DRAFT_SERVICE);
const queueService = container.resolve<DraftQueueService>(KEYS.DRAFT_QUEUE_SERVICE);
const rosterRepo = container.resolve<RosterRepository>(KEYS.ROSTER_REPO);

// Draft controller with queue support for unified /actions endpoint
const draftController = new DraftController(draftService, queueService, rosterRepo);

// Queue controller uses service layer only
const queueController = new DraftQueueController(queueService);

const router = Router({ mergeParams: true }); // mergeParams to access :leagueId

// All draft routes require authentication
router.use(authMiddleware);

// GET /api/leagues/:leagueId/drafts
router.get('/', draftController.getLeagueDrafts);

// POST /api/leagues/:leagueId/drafts
router.post('/', draftModifyLimiter, validateRequest(createDraftSchema), draftController.createDraft);

// GET /api/leagues/:leagueId/drafts/:draftId
router.get('/:draftId', draftController.getDraft);

// DELETE /api/leagues/:leagueId/drafts/:draftId
router.delete('/:draftId', draftController.deleteDraft);

// GET /api/leagues/:leagueId/drafts/:draftId/order
router.get('/:draftId/order', draftController.getDraftOrder);

// POST /api/leagues/:leagueId/drafts/:draftId/randomize
router.post('/:draftId/randomize', draftModifyLimiter, draftController.randomizeDraftOrder);

// POST /api/leagues/:leagueId/drafts/:draftId/start
router.post('/:draftId/start', draftModifyLimiter, draftController.startDraft);

// POST /api/leagues/:leagueId/drafts/:draftId/actions (unified action endpoint)
router.post('/:draftId/actions', draftModifyLimiter, validateRequest(draftActionSchema), draftController.performAction);

// POST /api/leagues/:leagueId/drafts/:draftId/undo (commissioner undo last pick)
router.post('/:draftId/undo', draftModifyLimiter, draftController.undoPick);

// GET /api/leagues/:leagueId/drafts/:draftId/picks
router.get('/:draftId/picks', draftController.getDraftPicks);

// POST /api/leagues/:leagueId/drafts/:draftId/pick
router.post('/:draftId/pick', draftPickLimiter, validateRequest(makePickSchema), draftController.makePick);

// Queue routes
// GET /api/leagues/:leagueId/drafts/:draftId/queue
router.get('/:draftId/queue', queueController.getQueue);

// POST /api/leagues/:leagueId/drafts/:draftId/queue
router.post('/:draftId/queue', queueLimiter, validateRequest(addToQueueSchema), queueController.addToQueue);

// PUT /api/leagues/:leagueId/drafts/:draftId/queue (reorder)
router.put('/:draftId/queue', queueLimiter, validateRequest(reorderQueueSchema), queueController.reorderQueue);

// DELETE /api/leagues/:leagueId/drafts/:draftId/queue/:playerId
router.delete('/:draftId/queue/:playerId', queueLimiter, queueController.removeFromQueue);

export default router;
