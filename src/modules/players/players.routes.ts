import { Router } from 'express';
import { Pool } from 'pg';
import { PlayerController } from './players.controller';
import { PlayerService } from './players.service';
import { authMiddleware } from '../../middleware/auth.middleware';
import { validateRequest } from '../../middleware/validation.middleware';
import { apiReadLimiter, playerSyncLimiter } from '../../middleware/rate-limit.middleware';
import { container, KEYS } from '../../container';
import { asyncHandler } from '../../shared/async-handler';
import {
  playerQuerySchema,
  playerSearchSchema,
  syncCollegeSchema,
  playerNewsSchema,
  latestNewsSchema,
  breakingNewsSchema,
  gameLogsSchema,
  projectionSchema,
  trendsSchema,
} from './players.schemas';

// Resolve dependencies from container
const playerService = container.resolve<PlayerService>(KEYS.PLAYER_SERVICE);
const pool = container.resolve<Pool>(KEYS.POOL);
const playerController = new PlayerController(playerService, pool);

const router = Router();

// Public routes (still rate limited to prevent abuse)
router.get('/nfl-state', apiReadLimiter, asyncHandler(playerController.getNflState));

// Protected routes
router.use(authMiddleware);

// GET /api/players
router.get('/', apiReadLimiter, validateRequest(playerQuerySchema, 'query'), asyncHandler(playerController.getAllPlayers));

// GET /api/players/search?q=<query>&position=<pos>&team=<team>
router.get('/search', apiReadLimiter, validateRequest(playerSearchSchema, 'query'), asyncHandler(playerController.searchPlayers));

// POST /api/players/sync - Manual sync from Sleeper API
router.post('/sync', playerSyncLimiter, asyncHandler(playerController.syncPlayers));

// POST /api/players/sync-college - Manual sync from CFBD API
router.post('/sync-college', playerSyncLimiter, validateRequest(syncCollegeSchema, 'query'), asyncHandler(playerController.syncCollegePlayers));

// ========== NEWS ROUTES (Stream A) ==========
// GET /api/players/news/latest - Latest news across all players
router.get('/news/latest', apiReadLimiter, validateRequest(latestNewsSchema, 'query'), asyncHandler(playerController.getLatestNews));

// GET /api/players/news/breaking - Breaking news (critical/high impact)
router.get('/news/breaking', apiReadLimiter, validateRequest(breakingNewsSchema, 'query'), asyncHandler(playerController.getBreakingNews));

// ========== PLAYER-SPECIFIC ROUTES (must come after /news routes) ==========
// GET /api/players/:id
router.get('/:id', apiReadLimiter, asyncHandler(playerController.getPlayerById));

// GET /api/players/:id/news - News for specific player
router.get('/:id/news', apiReadLimiter, validateRequest(playerNewsSchema, 'query'), asyncHandler(playerController.getPlayerNews));

// GET /api/players/:id/stats/:season - Season stats
router.get('/:id/stats/:season', apiReadLimiter, asyncHandler(playerController.getPlayerSeasonStats));

// GET /api/players/:id/gamelogs - Recent game logs
router.get('/:id/gamelogs', apiReadLimiter, validateRequest(gameLogsSchema, 'query'), asyncHandler(playerController.getPlayerGameLogs));

// GET /api/players/:id/projections - Weekly projection
router.get('/:id/projections', apiReadLimiter, validateRequest(projectionSchema, 'query'), asyncHandler(playerController.getPlayerProjection));

// GET /api/players/:id/trends - Performance trends
router.get('/:id/trends', apiReadLimiter, validateRequest(trendsSchema, 'query'), asyncHandler(playerController.getPlayerTrends));

export default router;
