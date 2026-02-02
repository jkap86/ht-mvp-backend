import { Router } from 'express';
import { RostersController } from './rosters.controller';
import { RosterService } from './rosters.service';
import { LineupService } from '../lineups/lineups.service';
import { apiReadLimiter, rosterModifyLimiter } from '../../middleware/rate-limit.middleware';
import { container, KEYS } from '../../container';

// Resolve dependencies from container
const rosterService = container.resolve<RosterService>(KEYS.ROSTER_PLAYER_SERVICE);
const lineupService = container.resolve<LineupService>(KEYS.LINEUP_SERVICE);
const rostersController = new RostersController(rosterService, lineupService);

const router = Router({ mergeParams: true });

// All routes require authentication (handled by parent router)

// GET /api/leagues/:leagueId/rosters/:rosterId/players
router.get('/:rosterId/players', apiReadLimiter, rostersController.getRosterPlayers);

// POST /api/leagues/:leagueId/rosters/:rosterId/players
router.post('/:rosterId/players', rosterModifyLimiter, rostersController.addPlayer);

// DELETE /api/leagues/:leagueId/rosters/:rosterId/players/:playerId
router.delete('/:rosterId/players/:playerId', rosterModifyLimiter, rostersController.dropPlayer);

// POST /api/leagues/:leagueId/rosters/:rosterId/players/add-drop
router.post('/:rosterId/players/add-drop', rosterModifyLimiter, rostersController.addDropPlayer);

// GET /api/leagues/:leagueId/rosters/:rosterId/lineup
router.get('/:rosterId/lineup', apiReadLimiter, rostersController.getLineup);

// PUT /api/leagues/:leagueId/rosters/:rosterId/lineup
router.put('/:rosterId/lineup', rosterModifyLimiter, rostersController.setLineup);

// POST /api/leagues/:leagueId/rosters/:rosterId/lineup/move
router.post('/:rosterId/lineup/move', rosterModifyLimiter, rostersController.movePlayer);

export default router;
