import { Router } from 'express';
import { DraftPickAssetsController } from './draft-pick-assets.controller';
import { DraftPickAssetRepository } from './draft-pick-asset.repository';
import { AuthorizationService } from '../auth/authorization.service';
import { RosterRepository } from '../leagues/leagues.repository';
import { authMiddleware } from '../../middleware/auth.middleware';
import { apiReadLimiter } from '../../middleware/rate-limit.middleware';
import { container, KEYS } from '../../container';
import { asyncHandler } from '../../shared/async-handler';

// Resolve dependencies from container
const pickAssetRepo = container.resolve<DraftPickAssetRepository>(KEYS.PICK_ASSET_REPO);
const authService = container.resolve<AuthorizationService>(KEYS.AUTHORIZATION_SERVICE);
const rosterRepo = container.resolve<RosterRepository>(KEYS.ROSTER_REPO);

// Create controller
const pickAssetsController = new DraftPickAssetsController(pickAssetRepo, authService, rosterRepo);

// League-level routes (mounted under /api/leagues/:leagueId/pick-assets)
const leagueRouter = Router({ mergeParams: true });

// All routes require authentication and rate limiting
leagueRouter.use(authMiddleware);
leagueRouter.use(apiReadLimiter);

// GET /api/leagues/:leagueId/pick-assets
leagueRouter.get('/', asyncHandler(pickAssetsController.getLeaguePickAssets));

// GET /api/leagues/:leagueId/pick-assets/:season
leagueRouter.get('/:season', asyncHandler(pickAssetsController.getSeasonPickAssets));

// Roster-level routes (mounted under /api/rosters/:rosterId/pick-assets)
const rosterRouter = Router({ mergeParams: true });

// All routes require authentication and rate limiting
rosterRouter.use(authMiddleware);
rosterRouter.use(apiReadLimiter);

// GET /api/rosters/:rosterId/pick-assets
rosterRouter.get('/', asyncHandler(pickAssetsController.getRosterPickAssets));

export const leaguePickAssetsRoutes = leagueRouter;
export const rosterPickAssetsRoutes = rosterRouter;
