import { Router } from 'express';
import { container, KEYS } from '../../container';
import { PlayoffController } from './playoff.controller';
import { PlayoffService } from './playoff.service';
import { asyncHandler } from '../../shared/async-handler';
import { idempotencyMiddleware } from '../../middleware/idempotency.middleware';
import { Pool } from 'pg';

const router = Router({ mergeParams: true });
router.use(idempotencyMiddleware(container.resolve<Pool>(KEYS.POOL)));

const playoffController = new PlayoffController(
  container.resolve<PlayoffService>(KEYS.PLAYOFF_SERVICE)
);

// POST /api/leagues/:leagueId/playoffs/generate - Generate playoff bracket (commissioner only)
router.post('/generate', asyncHandler(playoffController.generateBracket));

// GET /api/leagues/:leagueId/playoffs/bracket - Get playoff bracket
router.get('/bracket', asyncHandler(playoffController.getBracket));

// POST /api/leagues/:leagueId/playoffs/advance - Advance winners (commissioner only)
router.post('/advance', asyncHandler(playoffController.advanceWinners));

export default router;
