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
import tradesRoutes from '../trades/trades.routes';
import { createWaiversRoutes } from '../waivers/waivers.routes';
import playoffRoutes from '../playoffs/playoff.routes';
import { WaiversController } from '../waivers/waivers.controller';
import { WaiversService } from '../waivers/waivers.service';
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

// Resolve waivers dependencies
const waiversService = container.resolve<WaiversService>(KEYS.WAIVERS_SERVICE);
const leagueRepo = container.resolve<any>(KEYS.LEAGUE_REPO);
const rosterRepo = container.resolve<any>(KEYS.ROSTER_REPO);
const waiversController = new WaiversController(waiversService, leagueRepo, rosterRepo);

const router = Router();

// All league routes require authentication
router.use(authMiddleware);

// GET /api/leagues/my-leagues
router.get('/my-leagues', leagueController.getMyLeagues);

// GET /api/leagues/discover - Discover public leagues
router.get('/discover', leagueController.discoverLeagues);

// POST /api/leagues/join/:inviteCode - Join league by invite code
router.post('/join/:inviteCode', leagueController.joinLeagueByInviteCode);

// GET /api/leagues/:id
router.get('/:id', leagueController.getLeague);

// POST /api/leagues
router.post('/', validateRequest(createLeagueSchema, 'body'), leagueController.createLeague);

// POST /api/leagues/:id/join - Join league (for public leagues or internal use)
router.post('/:id/join', leagueController.joinPublicLeague);

// PUT /api/leagues/:id
router.put('/:id', validateRequest(updateLeagueSchema, 'body'), leagueController.updateLeague);

// DELETE /api/leagues/:id
router.delete('/:id', leagueController.deleteLeague);

// POST /api/leagues/:id/reset - Reset league for new season (commissioner only)
router.post('/:id/reset', leagueController.resetLeague);

// GET /api/leagues/:id/members
router.get('/:id/members', leagueController.getMembers);

// DELETE /api/leagues/:id/members/:rosterId - Kick member from league (commissioner only)
router.delete('/:id/members/:rosterId', leagueController.kickMember);

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

// Mount trade routes - /api/leagues/:leagueId/trades/*
router.use('/:leagueId/trades', tradesRoutes);

// Mount waiver routes - /api/leagues/:leagueId/waivers/*
router.use('/:leagueId/waivers', createWaiversRoutes(waiversController));

// Mount playoff routes - /api/leagues/:leagueId/playoffs/*
router.use('/:leagueId/playoffs', playoffRoutes);

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
