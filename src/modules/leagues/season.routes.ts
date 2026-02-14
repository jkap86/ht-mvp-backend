/**
 * Season Management Routes
 * Endpoints for managing league seasons and keeper selections
 */

import { Router, Response } from 'express';
import { Pool } from 'pg';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';
import { asyncHandler } from '../../shared/async-handler';
import { container, KEYS } from '../../container';
import { LeagueSeasonRepository } from './league-season.repository';
import { KeeperSelectionRepository } from './keeper-selection.repository';
import type { LeagueRepository } from './leagues.repository';
import { RolloverToNewSeasonUseCase } from './use-cases/rollover-to-new-season.use-case';
import { tryGetEventBus, EventTypes } from '../../shared/events';
import { getActiveLeagueSeasonId } from '../../shared/season-context';
import { SubmitKeeperSelectionUseCase } from './use-cases/submit-keeper-selection.use-case';
import { ApplyKeepersToRostersUseCase } from './use-cases/apply-keepers-to-rosters.use-case';
import { LeagueOperationsRepository } from './league-operations.repository';

export function createSeasonRoutes(pool: Pool): Router {
  const router = Router();

  const leagueSeasonRepo = new LeagueSeasonRepository(pool);
  const keeperRepo = new KeeperSelectionRepository(pool);
  const leagueRepo = container.resolve<LeagueRepository>(KEYS.LEAGUE_REPO);
  const leagueOpsRepo = new LeagueOperationsRepository(pool);

  const rolloverUseCase = new RolloverToNewSeasonUseCase(pool, leagueRepo, leagueSeasonRepo, leagueOpsRepo);
  const submitKeepersUseCase = new SubmitKeeperSelectionUseCase(pool, leagueSeasonRepo, keeperRepo, leagueRepo);
  const applyKeepersUseCase = new ApplyKeepersToRostersUseCase(pool, keeperRepo, leagueSeasonRepo, leagueRepo);

  /**
   * GET /leagues/:leagueId/seasons
   * List all seasons for a league (history)
   */
  router.get('/leagues/:leagueId/seasons', authMiddleware, asyncHandler(async (req: AuthRequest, res: Response) => {
    const leagueId = parseInt(req.params.leagueId as string, 10);
    const seasons = await leagueSeasonRepo.findAllByLeague(leagueId);

    res.json({
      seasons: seasons.map(s => ({
        id: s.id,
        leagueId: s.leagueId,
        season: s.season,
        status: s.status,
        seasonStatus: s.seasonStatus,
        currentWeek: s.currentWeek,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
        createdAt: s.createdAt
      }))
    });
  }));

  /**
   * GET /leagues/:leagueId/seasons/active
   * Get the active (current) season for a league.
   * Uses leagues.active_league_season_id pointer for O(1) lookup,
   * falling back to status-based inference if pointer is not set.
   */
  router.get('/leagues/:leagueId/seasons/active', authMiddleware, asyncHandler(async (req: AuthRequest, res: Response) => {
    const leagueId = parseInt(req.params.leagueId as string, 10);

    let activeSeason = null;
    try {
      const activeSeasonId = await getActiveLeagueSeasonId(pool, leagueId);
      activeSeason = await leagueSeasonRepo.findById(activeSeasonId);
    } catch {
      // Fallback: pointer not set, infer from status
      activeSeason = await leagueSeasonRepo.findActiveByLeague(leagueId);
    }

    if (!activeSeason) {
      return res.status(404).json({ error: 'No active season found for this league' });
    }

    res.json({
      season: {
        id: activeSeason.id,
        leagueId: activeSeason.leagueId,
        season: activeSeason.season,
        status: activeSeason.status,
        seasonStatus: activeSeason.seasonStatus,
        currentWeek: activeSeason.currentWeek,
        seasonSettings: activeSeason.seasonSettings,
        startedAt: activeSeason.startedAt,
        completedAt: activeSeason.completedAt
      }
    });
  }));

  /**
   * GET /leagues/:leagueId/seasons/:seasonId
   * Get a specific season by ID
   */
  router.get('/leagues/:leagueId/seasons/:seasonId', authMiddleware, asyncHandler(async (req: AuthRequest, res: Response) => {
    const seasonId = parseInt(req.params.seasonId as string, 10);
    const season = await leagueSeasonRepo.findById(seasonId);

    if (!season) {
      return res.status(404).json({ error: 'Season not found' });
    }

    res.json({
      season: {
        id: season.id,
        leagueId: season.leagueId,
        season: season.season,
        status: season.status,
        seasonStatus: season.seasonStatus,
        currentWeek: season.currentWeek,
        seasonSettings: season.seasonSettings,
        startedAt: season.startedAt,
        completedAt: season.completedAt
      }
    });
  }));

  /**
   * POST /leagues/:leagueId/seasons/rollover
   * Rollover to a new season (dynasty/keeper leagues)
   */
  router.post('/leagues/:leagueId/seasons/rollover', authMiddleware, asyncHandler(async (req: AuthRequest, res: Response) => {
    const leagueId = parseInt(req.params.leagueId as string, 10);
    const { keeperDeadline } = req.body;

    const result = await rolloverUseCase.execute({
      leagueId,
      keeperDeadline: keeperDeadline ? new Date(keeperDeadline) : undefined,
      userId: req.user?.userId
    });

    // Emit socket event AFTER transaction commits (use case runs inside runWithLock)
    const eventBus = tryGetEventBus();
    eventBus?.publish({
      type: EventTypes.SEASON_ROLLED_OVER,
      leagueId,
      payload: {
        leagueId,
        newSeasonId: result.newSeason.id,
        previousSeasonId: result.previousSeason.id,
      },
    });

    res.json({
      message: 'Season rolled over successfully',
      newSeason: {
        id: result.newSeason.id,
        season: result.newSeason.season,
        status: result.newSeason.status,
        seasonSettings: result.newSeason.seasonSettings
      },
      previousSeason: {
        id: result.previousSeason.id,
        season: result.previousSeason.season,
        status: result.previousSeason.status
      }
    });
  }));

  /**
   * GET /leagues/:leagueId/seasons/:seasonId/keepers
   * Get all keeper selections for a season
   */
  router.get('/leagues/:leagueId/seasons/:seasonId/keepers', authMiddleware, asyncHandler(async (req: AuthRequest, res: Response) => {
    const seasonId = parseInt(req.params.seasonId as string, 10);
    const keepersWithDetails = await keeperRepo.findByLeagueSeasonWithDetails(seasonId);

    res.json({
      keepers: keepersWithDetails.map(k => ({
        id: k.id,
        rosterId: k.rosterId,
        playerId: k.playerId,
        playerName: k.playerName,
        playerPosition: k.playerPosition,
        playerTeam: k.playerTeam,
        draftPickAssetId: k.draftPickAssetId,
        pickAssetLabel: k.pickAssetLabel,
        keeperRoundCost: k.keeperRoundCost,
        selectedAt: k.selectedAt
      }))
    });
  }));

  /**
   * GET /leagues/:leagueId/seasons/:seasonId/keepers/:rosterId
   * Get keeper selections for a specific roster
   */
  router.get('/leagues/:leagueId/seasons/:seasonId/keepers/:rosterId', authMiddleware, asyncHandler(async (req: AuthRequest, res: Response) => {
    const seasonId = parseInt(req.params.seasonId as string, 10);
    const rosterId = parseInt(req.params.rosterId as string, 10);

    const keepers = await keeperRepo.findByRoster(rosterId, seasonId);

    res.json({
      keepers: keepers.map(k => ({
        id: k.id,
        playerId: k.playerId,
        draftPickAssetId: k.draftPickAssetId,
        keeperRoundCost: k.keeperRoundCost,
        selectedAt: k.selectedAt
      }))
    });
  }));

  /**
   * POST /leagues/:leagueId/seasons/:seasonId/keepers
   * Submit keeper selections for a roster
   */
  router.post('/leagues/:leagueId/seasons/:seasonId/keepers', authMiddleware, asyncHandler(async (req: AuthRequest, res: Response) => {
    const seasonId = parseInt(req.params.seasonId as string, 10);
    const { rosterId, selections } = req.body;

    if (!rosterId) {
      return res.status(400).json({ error: 'rosterId is required' });
    }

    if (!Array.isArray(selections)) {
      return res.status(400).json({ error: 'selections must be an array' });
    }

    const keepers = await submitKeepersUseCase.execute({
      leagueSeasonId: seasonId,
      rosterId,
      selections,
      userId: req.user?.userId
    });

    res.json({
      message: 'Keeper selections submitted successfully',
      keepers: keepers.map(k => ({
        id: k.id,
        playerId: k.playerId,
        draftPickAssetId: k.draftPickAssetId,
        keeperRoundCost: k.keeperRoundCost
      }))
    });
  }));

  /**
   * POST /leagues/:leagueId/seasons/:seasonId/keepers/apply
   * Apply keeper selections to rosters (commissioner only)
   */
  router.post('/leagues/:leagueId/seasons/:seasonId/keepers/apply', authMiddleware, asyncHandler(async (req: AuthRequest, res: Response) => {
    const seasonId = parseInt(req.params.seasonId as string, 10);

    const result = await applyKeepersUseCase.execute(seasonId);

    res.json({
      message: 'Keepers applied successfully',
      playersAdded: result.playersAdded,
      assetsKept: result.assetsKept
    });
  }));

  return router;
}
