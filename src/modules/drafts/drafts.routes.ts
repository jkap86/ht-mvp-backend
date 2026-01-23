import { Router } from 'express';
import { DraftController } from './drafts.controller';
import { DraftService } from './drafts.service';
import { authMiddleware } from '../../middleware/auth.middleware';
import { container, KEYS } from '../../container';

// Resolve dependencies from container
const draftService = container.resolve<DraftService>(KEYS.DRAFT_SERVICE);
const draftController = new DraftController(draftService);

const router = Router({ mergeParams: true }); // mergeParams to access :leagueId

// All draft routes require authentication
router.use(authMiddleware);

// GET /api/leagues/:leagueId/drafts
router.get('/', draftController.getLeagueDrafts);

// POST /api/leagues/:leagueId/drafts
router.post('/', draftController.createDraft);

// GET /api/leagues/:leagueId/drafts/:draftId
router.get('/:draftId', draftController.getDraft);

// DELETE /api/leagues/:leagueId/drafts/:draftId
router.delete('/:draftId', draftController.deleteDraft);

// GET /api/leagues/:leagueId/drafts/:draftId/order
router.get('/:draftId/order', draftController.getDraftOrder);

// POST /api/leagues/:leagueId/drafts/:draftId/randomize
router.post('/:draftId/randomize', draftController.randomizeDraftOrder);

// POST /api/leagues/:leagueId/drafts/:draftId/start
router.post('/:draftId/start', draftController.startDraft);

// GET /api/leagues/:leagueId/drafts/:draftId/picks
router.get('/:draftId/picks', draftController.getDraftPicks);

// POST /api/leagues/:leagueId/drafts/:draftId/pick
router.post('/:draftId/pick', draftController.makePick);

export default router;
