import { Router } from 'express';
import { container, KEYS } from '../../container';
import { PlayoffController } from './playoff.controller';
import { PlayoffService } from './playoff.service';

const router = Router({ mergeParams: true });

const playoffController = new PlayoffController(
  container.resolve<PlayoffService>(KEYS.PLAYOFF_SERVICE)
);

// POST /api/leagues/:leagueId/playoffs/generate - Generate playoff bracket (commissioner only)
router.post('/generate', playoffController.generateBracket);

// GET /api/leagues/:leagueId/playoffs/bracket - Get playoff bracket
router.get('/bracket', playoffController.getBracket);

// POST /api/leagues/:leagueId/playoffs/advance - Advance winners (commissioner only)
router.post('/advance', playoffController.advanceWinners);

export default router;
