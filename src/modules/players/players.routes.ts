import { Router } from 'express';
import { PlayerController } from './players.controller';
import { PlayerService } from './players.service';
import { authMiddleware } from '../../middleware/auth.middleware';
import { apiReadLimiter } from '../../middleware/rate-limit.middleware';
import { container, KEYS } from '../../container';

// Resolve dependencies from container
const playerService = container.resolve<PlayerService>(KEYS.PLAYER_SERVICE);
const playerController = new PlayerController(playerService);

const router = Router();

// Public routes (still rate limited to prevent abuse)
router.get('/nfl-state', apiReadLimiter, playerController.getNflState);

// Protected routes
router.use(authMiddleware);

// GET /api/players
router.get('/', apiReadLimiter, playerController.getAllPlayers);

// GET /api/players/search?q=<query>&position=<pos>&team=<team>
router.get('/search', apiReadLimiter, playerController.searchPlayers);

// POST /api/players/sync - Manual sync from Sleeper API
router.post('/sync', playerController.syncPlayers);

// POST /api/players/sync-college - Manual sync from CFBD API
router.post('/sync-college', playerController.syncCollegePlayers);

// GET /api/players/:id
router.get('/:id', apiReadLimiter, playerController.getPlayerById);

export default router;
