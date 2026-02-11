import { Router } from 'express';
import { LeagueController } from './leagues.controller';
import { LeagueService } from './leagues.service';
import { DashboardService } from './dashboard.service';
import { authMiddleware } from '../../middleware/auth.middleware';
import { validateRequest } from '../../middleware/validation.middleware';
import { draftModifyLimiter, apiReadLimiter } from '../../middleware/rate-limit.middleware';
import { createLeagueSchema, updateLeagueSchema } from './leagues.schemas';
import { container, KEYS } from '../../container';
import draftRoutes from '../drafts/drafts.routes';
import { leaguePickAssetsRoutes } from '../drafts/draft-pick-assets.routes';
import chatRoutes from '../chat/chat.routes';
import rosterRoutes from '../rosters/rosters.routes';
import matchupRoutes from '../matchups/matchups.routes';
import tradesRoutes from '../trades/trades.routes';
import { createWaiversRoutes } from '../waivers/waivers.routes';
import playoffRoutes from '../playoffs/playoff.routes';
import {
  createLeagueInvitationRoutes,
  createUserSearchRoutes,
} from '../invitations/invitations.routes';
import { createDuesRoutes } from '../dues/dues.routes';
import { WaiversController } from '../waivers/waivers.controller';
import { WaiversService } from '../waivers/waivers.service';
import { AuthorizationService } from '../auth/authorization.service';
import { RostersController } from '../rosters/rosters.controller';
import { MatchupsController } from '../matchups/matchups.controller';
import { RosterService } from './roster.service';
import { RosterService as RosterPlayerService } from '../rosters/rosters.service';
import { LineupService } from '../lineups/lineups.service';
import { MatchupService } from '../matchups/matchups.service';
import { ScoringService } from '../scoring/scoring.service';
import { ScheduleGeneratorService } from '../matchups/schedule-generator.service';
import { StandingsService } from '../matchups/standings.service';
import { getDraftStructures } from '../drafts/draft-structure-presets';

// Resolve dependencies from container
const leagueService = container.resolve<LeagueService>(KEYS.LEAGUE_SERVICE);
const leagueRosterService = container.resolve<RosterService>(KEYS.ROSTER_SERVICE);
const dashboardService = container.resolve<DashboardService>(KEYS.DASHBOARD_SERVICE);
const leagueController = new LeagueController(leagueService, leagueRosterService, dashboardService);

// Resolve season management services
const rosterService = container.resolve<RosterPlayerService>(KEYS.ROSTER_PLAYER_SERVICE);
const lineupService = container.resolve<LineupService>(KEYS.LINEUP_SERVICE);
const matchupService = container.resolve<MatchupService>(KEYS.MATCHUP_SERVICE);
const scoringService = container.resolve<ScoringService>(KEYS.SCORING_SERVICE);
const scheduleGeneratorService = container.resolve<ScheduleGeneratorService>(
  KEYS.SCHEDULE_GENERATOR_SERVICE
);
const standingsService = container.resolve<StandingsService>(KEYS.STANDINGS_SERVICE);
const rostersController = new RostersController(rosterService, lineupService);
const matchupsController = new MatchupsController(
  matchupService,
  scoringService,
  leagueService,
  scheduleGeneratorService,
  standingsService
);

// Resolve waivers dependencies
const waiversService = container.resolve<WaiversService>(KEYS.WAIVERS_SERVICE);
const authorizationService = container.resolve<AuthorizationService>(KEYS.AUTHORIZATION_SERVICE);
const waiversController = new WaiversController(waiversService, authorizationService);

const router = Router();

// All league routes require authentication
router.use(authMiddleware);

// GET /api/leagues/draft-structures - Get available draft structure options
router.get('/draft-structures', apiReadLimiter, (req, res) => {
  const mode = (req.query.mode as string) || 'redraft';
  const structures = getDraftStructures(mode);
  res.json(structures);
});

// GET /api/leagues/my-leagues
router.get('/my-leagues', apiReadLimiter, leagueController.getMyLeagues);

// GET /api/leagues/discover - Discover public leagues
router.get('/discover', apiReadLimiter, leagueController.discoverLeagues);

// GET /api/leagues/:id
router.get('/:id', apiReadLimiter, leagueController.getLeague);

// GET /api/leagues/:leagueId/dashboard - Get dashboard summary for league home
router.get('/:leagueId/dashboard', apiReadLimiter, leagueController.getDashboard);

// POST /api/leagues
router.post('/', draftModifyLimiter, validateRequest(createLeagueSchema, 'body'), leagueController.createLeague);

// POST /api/leagues/:id/join - Join league (for public leagues or internal use)
router.post('/:id/join', draftModifyLimiter, leagueController.joinPublicLeague);

// PUT /api/leagues/:id
router.put('/:id', draftModifyLimiter, validateRequest(updateLeagueSchema, 'body'), leagueController.updateLeague);

// DELETE /api/leagues/:id
router.delete('/:id', draftModifyLimiter, leagueController.deleteLeague);

// POST /api/leagues/:id/reset - Reset league for new season (commissioner only)
router.post('/:id/reset', draftModifyLimiter, leagueController.resetLeague);

// POST /api/leagues/:id/season-controls - Update season status/week (commissioner only)
router.post('/:id/season-controls', draftModifyLimiter, leagueController.updateSeasonControls);

// GET /api/leagues/:id/members
router.get('/:id/members', apiReadLimiter, leagueController.getMembers);

// DELETE /api/leagues/:id/members/:rosterId - Kick member from league (commissioner only)
router.delete('/:id/members/:rosterId', draftModifyLimiter, leagueController.kickMember);

// POST /api/leagues/:id/members/:rosterId/reinstate - Reinstate benched member (commissioner only)
router.post('/:id/members/:rosterId/reinstate', draftModifyLimiter, leagueController.reinstateMember);

// POST /api/leagues/:id/dev/add-users - Dev endpoint to add multiple users to league
if (process.env.NODE_ENV === 'development') {
  router.post('/:id/dev/add-users', leagueController.devAddUsers);
}

// Mount draft routes - /api/leagues/:leagueId/drafts/*
router.use('/:leagueId/drafts', draftRoutes);

// Mount pick assets routes - /api/leagues/:leagueId/pick-assets/*
router.use('/:leagueId/pick-assets', leaguePickAssetsRoutes);

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

// Mount invitation routes - /api/leagues/:leagueId/invitations/*
router.use('/:leagueId/invitations', createLeagueInvitationRoutes());

// Mount user search routes - /api/leagues/:leagueId/users/*
router.use('/:leagueId/users', createUserSearchRoutes());

// Mount dues routes - /api/leagues/:leagueId/dues/*
router.use('/:leagueId/dues', createDuesRoutes());

// Free agents - GET /api/leagues/:leagueId/free-agents
router.get('/:leagueId/free-agents', apiReadLimiter, rostersController.getFreeAgents);

// Transactions - GET /api/leagues/:leagueId/transactions
router.get('/:leagueId/transactions', apiReadLimiter, rostersController.getTransactions);

// Lineups lock - POST /api/leagues/:leagueId/lineups/lock
router.post('/:leagueId/lineups/lock', draftModifyLimiter, rostersController.lockLineups);

// Standings - GET /api/leagues/:leagueId/standings
router.get('/:leagueId/standings', apiReadLimiter, matchupsController.getStandings);

// Schedule generation - POST /api/leagues/:leagueId/schedule/generate
router.post('/:leagueId/schedule/generate', draftModifyLimiter, matchupsController.generateSchedule);

// Scoring rules - GET /api/leagues/:leagueId/scoring/rules
router.get('/:leagueId/scoring/rules', apiReadLimiter, matchupsController.getScoringRules);

// Score calculation - POST /api/leagues/:leagueId/scoring/calculate
router.post('/:leagueId/scoring/calculate', draftModifyLimiter, matchupsController.calculateScores);

export default router;
