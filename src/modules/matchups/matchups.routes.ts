import { Router } from 'express';
import { MatchupsController } from './matchups.controller';
import { MatchupService } from './matchups.service';
import { ScoringService } from '../scoring/scoring.service';
import { LeagueService } from '../leagues/leagues.service';
import { MedianService } from './median.service';
import { apiReadLimiter, draftModifyLimiter } from '../../middleware/rate-limit.middleware';
import { container, KEYS } from '../../container';

// Resolve dependencies from container
const matchupService = container.resolve<MatchupService>(KEYS.MATCHUP_SERVICE);
const scoringService = container.resolve<ScoringService>(KEYS.SCORING_SERVICE);
const leagueService = container.resolve<LeagueService>(KEYS.LEAGUE_SERVICE);
const medianService = container.resolve<MedianService>(KEYS.MEDIAN_SERVICE);
const matchupsController = new MatchupsController(
  matchupService,
  scoringService,
  leagueService,
  undefined, // scheduleGeneratorService
  undefined, // standingsService
  medianService
);

const router = Router({ mergeParams: true });

// All routes require authentication (handled by parent router)

// GET /api/leagues/:leagueId/matchups
router.get('/', apiReadLimiter, matchupsController.getMatchups);

// GET /api/leagues/:leagueId/matchups/:matchupId
router.get('/:matchupId', apiReadLimiter, matchupsController.getMatchup);

// GET /api/leagues/:leagueId/matchups/:matchupId/detail
router.get('/:matchupId/detail', apiReadLimiter, matchupsController.getMatchupWithLineups);

// POST /api/leagues/:leagueId/matchups/finalize
router.post('/finalize', draftModifyLimiter, matchupsController.finalizeMatchups);

// POST /api/leagues/:leagueId/matchups/median/recalculate
router.post('/median/recalculate', draftModifyLimiter, matchupsController.recalculateMedian);

// GET /api/leagues/:leagueId/standings
// (Mounted separately on leagues router)

// POST /api/leagues/:leagueId/schedule/generate
// (Mounted separately on leagues router)

// GET /api/leagues/:leagueId/scoring/rules
// (Mounted separately on leagues router)

// POST /api/leagues/:leagueId/scoring/calculate
// (Mounted separately on leagues router)

export default router;
