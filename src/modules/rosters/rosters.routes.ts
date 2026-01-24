import { Router } from 'express';
import { RostersController } from './rosters.controller';
import { RosterService } from './rosters.service';
import { LineupService } from '../lineups/lineups.service';
import { container, KEYS } from '../../container';

// Resolve dependencies from container
const rosterService = container.resolve<RosterService>(KEYS.ROSTER_PLAYER_SERVICE);
const lineupService = container.resolve<LineupService>(KEYS.LINEUP_SERVICE);
const rostersController = new RostersController(rosterService, lineupService);

const router = Router({ mergeParams: true });

// All routes require authentication (handled by parent router)

// GET /api/leagues/:leagueId/rosters/:rosterId/players
router.get('/:rosterId/players', rostersController.getRosterPlayers);

// POST /api/leagues/:leagueId/rosters/:rosterId/players
router.post('/:rosterId/players', rostersController.addPlayer);

// DELETE /api/leagues/:leagueId/rosters/:rosterId/players/:playerId
router.delete('/:rosterId/players/:playerId', rostersController.dropPlayer);

// POST /api/leagues/:leagueId/rosters/:rosterId/players/add-drop
router.post('/:rosterId/players/add-drop', rostersController.addDropPlayer);

// GET /api/leagues/:leagueId/rosters/:rosterId/lineup
router.get('/:rosterId/lineup', rostersController.getLineup);

// PUT /api/leagues/:leagueId/rosters/:rosterId/lineup
router.put('/:rosterId/lineup', rostersController.setLineup);

// POST /api/leagues/:leagueId/rosters/:rosterId/lineup/move
router.post('/:rosterId/lineup/move', rostersController.movePlayer);

export default router;
