import { Router } from 'express';
import { PlayerController } from './players.controller';
import { PlayerService } from './players.service';
import { authMiddleware } from '../../middleware/auth.middleware';
import { container, KEYS } from '../../container';

// Resolve dependencies from container
const playerService = container.resolve<PlayerService>(KEYS.PLAYER_SERVICE);
const playerController = new PlayerController(playerService);

const router = Router();

// Public routes
router.get('/nfl-state', playerController.getNflState);

// Protected routes
router.use(authMiddleware);

// GET /api/players
router.get('/', playerController.getAllPlayers);

// GET /api/players/search?q=<query>&position=<pos>&team=<team>
router.get('/search', playerController.searchPlayers);

// POST /api/players/sync - Manual sync from Sleeper API
router.post('/sync', playerController.syncPlayers);

// POST /api/players/sync-college - Manual sync from CFBD API
router.post('/sync-college', playerController.syncCollegePlayers);

// GET /api/players/:id
router.get('/:id', playerController.getPlayerById);

export default router;
