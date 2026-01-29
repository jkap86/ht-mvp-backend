import { Router } from 'express';
import { DraftPickAssetsController } from './draft-pick-assets.controller';
import { DraftPickAssetRepository } from './draft-pick-asset.repository';
import { AuthorizationService } from '../auth/authorization.service';
import { RosterRepository } from '../leagues/leagues.repository';
import { authMiddleware } from '../../middleware/auth.middleware';
import { container, KEYS } from '../../container';
import { pool } from '../../db/pool';

// Create pick asset repository (not in container, instantiate directly)
const pickAssetRepo = new DraftPickAssetRepository(pool);

// Resolve dependencies from container
const authService = container.resolve<AuthorizationService>(KEYS.AUTHORIZATION_SERVICE);
const rosterRepo = container.resolve<RosterRepository>(KEYS.ROSTER_REPO);

// Create controller
const pickAssetsController = new DraftPickAssetsController(pickAssetRepo, authService, rosterRepo);

// League-level routes (mounted under /api/leagues/:leagueId/pick-assets)
const leagueRouter = Router({ mergeParams: true });

// All routes require authentication
leagueRouter.use(authMiddleware);

// GET /api/leagues/:leagueId/pick-assets
leagueRouter.get('/', pickAssetsController.getLeaguePickAssets);

// GET /api/leagues/:leagueId/pick-assets/:season
leagueRouter.get('/:season', pickAssetsController.getSeasonPickAssets);

// Roster-level routes (mounted under /api/rosters/:rosterId/pick-assets)
const rosterRouter = Router({ mergeParams: true });

// All routes require authentication
rosterRouter.use(authMiddleware);

// GET /api/rosters/:rosterId/pick-assets
rosterRouter.get('/', pickAssetsController.getRosterPickAssets);

export const leaguePickAssetsRoutes = leagueRouter;
export const rosterPickAssetsRoutes = rosterRouter;
