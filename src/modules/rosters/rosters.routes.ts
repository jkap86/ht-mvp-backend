import { Router } from 'express';
import { RostersController } from './rosters.controller';
import { RosterService } from './rosters.service';
import { LineupService } from '../lineups/lineups.service';
import { apiReadLimiter, rosterModifyLimiter } from '../../middleware/rate-limit.middleware';
import { container, KEYS } from '../../container';
import { asyncHandler } from '../../shared/async-handler';
import { idempotencyMiddleware } from '../../middleware/idempotency.middleware';
import { Pool } from 'pg';

// Resolve dependencies from container
const rosterService = container.resolve<RosterService>(KEYS.ROSTER_PLAYER_SERVICE);
const lineupService = container.resolve<LineupService>(KEYS.LINEUP_SERVICE);
const rostersController = new RostersController(rosterService, lineupService);

const router = Router({ mergeParams: true });

// Idempotency middleware (auth handled by parent router)
router.use(idempotencyMiddleware(container.resolve<Pool>(KEYS.POOL)));

// GET /api/leagues/:leagueId/rosters/:rosterId/players
router.get('/:rosterId/players', apiReadLimiter, asyncHandler(rostersController.getRosterPlayers));

// POST /api/leagues/:leagueId/rosters/:rosterId/players
router.post('/:rosterId/players', rosterModifyLimiter, asyncHandler(rostersController.addPlayer));

// DELETE /api/leagues/:leagueId/rosters/:rosterId/players/:playerId
router.delete('/:rosterId/players/:playerId', rosterModifyLimiter, asyncHandler(rostersController.dropPlayer));

// POST /api/leagues/:leagueId/rosters/:rosterId/players/add-drop
router.post('/:rosterId/players/add-drop', rosterModifyLimiter, asyncHandler(rostersController.addDropPlayer));

// GET /api/leagues/:leagueId/rosters/:rosterId/lineup
router.get('/:rosterId/lineup', apiReadLimiter, asyncHandler(rostersController.getLineup));

// PUT /api/leagues/:leagueId/rosters/:rosterId/lineup
router.put('/:rosterId/lineup', rosterModifyLimiter, asyncHandler(rostersController.setLineup));

// POST /api/leagues/:leagueId/rosters/:rosterId/lineup/move
router.post('/:rosterId/lineup/move', rosterModifyLimiter, asyncHandler(rostersController.movePlayer));

export default router;
