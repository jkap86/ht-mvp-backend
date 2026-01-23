import { Router } from 'express';
import { LeagueController } from './leagues.controller';
import { LeagueService } from './leagues.service';
import { LeagueRepository } from './leagues.repository';
import { authMiddleware } from '../../middleware/auth.middleware';
import { validateRequest } from '../../middleware/validation.middleware';
import { createLeagueSchema, updateLeagueSchema } from './leagues.schemas';
import { container, KEYS } from '../../container';
import draftRoutes from '../drafts/drafts.routes';
import chatRoutes from '../chat/chat.routes';

// Resolve dependencies from container
const leagueService = container.resolve<LeagueService>(KEYS.LEAGUE_SERVICE);
const leagueRepo = container.resolve<LeagueRepository>(KEYS.LEAGUE_REPO);
const leagueController = new LeagueController(leagueService, leagueRepo);

const router = Router();

// All league routes require authentication
router.use(authMiddleware);

// GET /api/leagues/my-leagues
router.get('/my-leagues', leagueController.getMyLeagues);

// GET /api/leagues/:id
router.get('/:id', leagueController.getLeague);

// POST /api/leagues
router.post('/', validateRequest(createLeagueSchema, 'body'), leagueController.createLeague);

// POST /api/leagues/:id/join
router.post('/:id/join', leagueController.joinLeague);

// PUT /api/leagues/:id
router.put('/:id', validateRequest(updateLeagueSchema, 'body'), leagueController.updateLeague);

// DELETE /api/leagues/:id
router.delete('/:id', leagueController.deleteLeague);

// GET /api/leagues/:id/members
router.get('/:id/members', leagueController.getMembers);

// POST /api/leagues/:id/dev/add-users - Dev endpoint to add multiple users to league
router.post('/:id/dev/add-users', leagueController.devAddUsers);

// Mount draft routes - /api/leagues/:leagueId/drafts/*
router.use('/:leagueId/drafts', draftRoutes);

// Mount chat routes - /api/leagues/:leagueId/chat
router.use('/:leagueId/chat', chatRoutes);

export default router;
