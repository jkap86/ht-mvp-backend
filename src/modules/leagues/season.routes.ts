/**
 * Season Management Routes
 * Endpoints for managing league seasons and keeper selections
 */

import { Router, Response } from 'express';
import { Pool } from 'pg';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';
import { LeagueSeasonRepository } from './league-season.repository';
import { KeeperSelectionRepository } from './keeper-selection.repository';
import { LeagueRepository } from './leagues.repository';
import { RolloverToNewSeasonUseCase } from './use-cases/rollover-to-new-season.use-case';
import { SubmitKeeperSelectionUseCase } from './use-cases/submit-keeper-selection.use-case';
import { ApplyKeepersToRostersUseCase } from './use-cases/apply-keepers-to-rosters.use-case';

export function createSeasonRoutes(pool: Pool): Router {
  const router = Router();

  const leagueSeasonRepo = new LeagueSeasonRepository(pool);
  const keeperRepo = new KeeperSelectionRepository(pool);
  const leagueRepo = new LeagueRepository(pool);

  const rolloverUseCase = new RolloverToNewSeasonUseCase(pool, leagueRepo, leagueSeasonRepo);
  const submitKeepersUseCase = new SubmitKeeperSelectionUseCase(pool, leagueSeasonRepo, keeperRepo, leagueRepo);
  const applyKeepersUseCase = new ApplyKeepersToRostersUseCase(pool, keeperRepo, leagueSeasonRepo);

  /**
   * GET /leagues/:leagueId/seasons
   * List all seasons for a league (history)
   */
  router.get('/leagues/:leagueId/seasons', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const leagueId = parseInt(req.params.leagueId as string);
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
    } catch (error: any) {
      console.error('Error fetching league seasons:', error);
      res.status(500).json({ error: error.message || 'Failed to fetch league seasons' });
    }
  });

  /**
   * GET /leagues/:leagueId/seasons/active
   * Get the active (current) season for a league
   */
  router.get('/leagues/:leagueId/seasons/active', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const leagueId = parseInt(req.params.leagueId as string);
      const activeSeason = await leagueSeasonRepo.findActiveByLeague(leagueId);

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
    } catch (error: any) {
      console.error('Error fetching active season:', error);
      res.status(500).json({ error: error.message || 'Failed to fetch active season' });
    }
  });

  /**
   * GET /leagues/:leagueId/seasons/:seasonId
   * Get a specific season by ID
   */
  router.get('/leagues/:leagueId/seasons/:seasonId', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const seasonId = parseInt(req.params.seasonId as string);
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
    } catch (error: any) {
      console.error('Error fetching season:', error);
      res.status(500).json({ error: error.message || 'Failed to fetch season' });
    }
  });

  /**
   * POST /leagues/:leagueId/seasons/rollover
   * Rollover to a new season (dynasty/keeper leagues)
   */
  router.post('/leagues/:leagueId/seasons/rollover', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const leagueId = parseInt(req.params.leagueId as string);
      const { keeperDeadline } = req.body;

      const result = await rolloverUseCase.execute({
        leagueId,
        keeperDeadline: keeperDeadline ? new Date(keeperDeadline) : undefined,
        userId: req.user?.userId
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
    } catch (error: any) {
      console.error('Error rolling over season:', error);
      res.status(400).json({ error: error.message || 'Failed to rollover season' });
    }
  });

  /**
   * GET /leagues/:leagueId/seasons/:seasonId/keepers
   * Get all keeper selections for a season
   */
  router.get('/leagues/:leagueId/seasons/:seasonId/keepers', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const seasonId = parseInt(req.params.seasonId as string);
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
    } catch (error: any) {
      console.error('Error fetching keeper selections:', error);
      res.status(500).json({ error: error.message || 'Failed to fetch keeper selections' });
    }
  });

  /**
   * GET /leagues/:leagueId/seasons/:seasonId/keepers/:rosterId
   * Get keeper selections for a specific roster
   */
  router.get('/leagues/:leagueId/seasons/:seasonId/keepers/:rosterId', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const seasonId = parseInt(req.params.seasonId as string);
      const rosterId = parseInt(req.params.rosterId as string);

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
    } catch (error: any) {
      console.error('Error fetching roster keepers:', error);
      res.status(500).json({ error: error.message || 'Failed to fetch roster keepers' });
    }
  });

  /**
   * POST /leagues/:leagueId/seasons/:seasonId/keepers
   * Submit keeper selections for a roster
   */
  router.post('/leagues/:leagueId/seasons/:seasonId/keepers', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const seasonId = parseInt(req.params.seasonId as string);
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
    } catch (error: any) {
      console.error('Error submitting keeper selections:', error);
      res.status(400).json({ error: error.message || 'Failed to submit keeper selections' });
    }
  });

  /**
   * POST /leagues/:leagueId/seasons/:seasonId/keepers/apply
   * Apply keeper selections to rosters (commissioner only)
   */
  router.post('/leagues/:leagueId/seasons/:seasonId/keepers/apply', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      const seasonId = parseInt(req.params.seasonId as string);

      const result = await applyKeepersUseCase.execute(seasonId);

      res.json({
        message: 'Keepers applied successfully',
        playersAdded: result.playersAdded,
        assetsKept: result.assetsKept
      });
    } catch (error: any) {
      console.error('Error applying keepers:', error);
      res.status(400).json({ error: error.message || 'Failed to apply keepers' });
    }
  });

  return router;
}
