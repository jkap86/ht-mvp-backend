import { Router } from 'express';
import { LeagueController } from './leagues.controller';
import { LeagueService } from './leagues.service';
import { authMiddleware } from '../../middleware/auth.middleware';
import { validateRequest } from '../../middleware/validation.middleware';
import { createLeagueSchema, updateLeagueSchema } from './leagues.schemas';
import { container, KEYS } from '../../container';
import draftRoutes from '../drafts/drafts.routes';
import chatRoutes from '../chat/chat.routes';
import rosterRoutes from '../rosters/rosters.routes';
import matchupRoutes from '../matchups/matchups.routes';
import { RostersController } from '../rosters/rosters.controller';
import { MatchupsController } from '../matchups/matchups.controller';
import { RosterService } from '../rosters/rosters.service';
import { LineupService } from '../lineups/lineups.service';
import { MatchupService } from '../matchups/matchups.service';
import { ScoringService } from '../scoring/scoring.service';

// Resolve dependencies from container
const leagueService = container.resolve<LeagueService>(KEYS.LEAGUE_SERVICE);
const leagueController = new LeagueController(leagueService);

// Resolve season management services
const rosterService = container.resolve<RosterService>(KEYS.ROSTER_PLAYER_SERVICE);
const lineupService = container.resolve<LineupService>(KEYS.LINEUP_SERVICE);
const matchupService = container.resolve<MatchupService>(KEYS.MATCHUP_SERVICE);
const scoringService = container.resolve<ScoringService>(KEYS.SCORING_SERVICE);
const rostersController = new RostersController(rosterService, lineupService);
const matchupsController = new MatchupsController(matchupService, scoringService);

const router = Router();

// All league routes require authentication
router.use(authMiddleware);

// GET /api/leagues/my-leagues
router.get('/my-leagues', leagueController.getMyLeagues);

// POST /api/leagues/join/:inviteCode - Join league by invite code
router.post('/join/:inviteCode', leagueController.joinLeagueByInviteCode);

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

// Mount roster routes - /api/leagues/:leagueId/rosters/*
router.use('/:leagueId/rosters', rosterRoutes);

// Mount matchup routes - /api/leagues/:leagueId/matchups/*
router.use('/:leagueId/matchups', matchupRoutes);

// Free agents - GET /api/leagues/:leagueId/free-agents
router.get('/:leagueId/free-agents', rostersController.getFreeAgents);

// Transactions - GET /api/leagues/:leagueId/transactions
router.get('/:leagueId/transactions', rostersController.getTransactions);

// Lineups lock - POST /api/leagues/:leagueId/lineups/lock
router.post('/:leagueId/lineups/lock', rostersController.lockLineups);

// Standings - GET /api/leagues/:leagueId/standings
router.get('/:leagueId/standings', matchupsController.getStandings);

// Schedule generation - POST /api/leagues/:leagueId/schedule/generate
router.post('/:leagueId/schedule/generate', matchupsController.generateSchedule);

// Scoring rules - GET /api/leagues/:leagueId/scoring/rules
router.get('/:leagueId/scoring/rules', matchupsController.getScoringRules);

// Score calculation - POST /api/leagues/:leagueId/scoring/calculate
router.post('/:leagueId/scoring/calculate', matchupsController.calculateScores);

export default router;
