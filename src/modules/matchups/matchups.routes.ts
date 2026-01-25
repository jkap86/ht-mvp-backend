import { Router } from 'express';
import { MatchupsController } from './matchups.controller';
import { MatchupService } from './matchups.service';
import { ScoringService } from '../scoring/scoring.service';
import { container, KEYS } from '../../container';

// Resolve dependencies from container
const matchupService = container.resolve<MatchupService>(KEYS.MATCHUP_SERVICE);
const scoringService = container.resolve<ScoringService>(KEYS.SCORING_SERVICE);
const matchupsController = new MatchupsController(matchupService, scoringService);

const router = Router({ mergeParams: true });

// All routes require authentication (handled by parent router)

// GET /api/leagues/:leagueId/matchups
router.get('/', matchupsController.getMatchups);

// GET /api/leagues/:leagueId/matchups/:matchupId
router.get('/:matchupId', matchupsController.getMatchup);

// GET /api/leagues/:leagueId/matchups/:matchupId/detail
router.get('/:matchupId/detail', matchupsController.getMatchupWithLineups);

// POST /api/leagues/:leagueId/matchups/finalize
router.post('/finalize', matchupsController.finalizeMatchups);

// GET /api/leagues/:leagueId/standings
// (Mounted separately on leagues router)

// POST /api/leagues/:leagueId/schedule/generate
// (Mounted separately on leagues router)

// GET /api/leagues/:leagueId/scoring/rules
// (Mounted separately on leagues router)

// POST /api/leagues/:leagueId/scoring/calculate
// (Mounted separately on leagues router)

export default router;
