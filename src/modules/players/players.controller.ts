import { Request, Response, NextFunction } from 'express';
import { PlayerService } from './players.service';
import { AuthRequest } from '../../middleware/auth.middleware';
import { requirePlayerId } from '../../utils/controller-helpers';
import { NewsRepository } from './news.repository';
import { StatsService } from './stats.service';
import { playerNewsToResponse } from './news.model';
import { Pool } from 'pg';

export class PlayerController {
  private newsRepo?: NewsRepository;
  private statsService?: StatsService;

  constructor(
    private readonly playerService: PlayerService,
    private readonly pool?: Pool
  ) {
    if (pool) {
      this.newsRepo = new NewsRepository(pool);
      this.statsService = new StatsService(pool);
    }
  }

  getAllPlayers = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10000;
      const offset = parseInt(req.query.offset as string) || 0;
      const query = req.query.q as string | undefined;
      const position = req.query.position as string | undefined;
      const team = req.query.team as string | undefined;
      const playerType = req.query.playerType as 'nfl' | 'college' | undefined;
      // playerPool is passed as comma-separated string (e.g., "veteran,rookie")
      const playerPoolParam = req.query.playerPool as string | undefined;
      const playerPool = playerPoolParam
        ? (playerPoolParam.split(',') as ('veteran' | 'rookie' | 'college')[])
        : undefined;

      // If any search/filter params provided, use search method
      if (query || position || team || playerType || playerPool) {
        const players = await this.playerService.searchPlayers(
          query || '',
          position,
          team,
          playerType,
          playerPool
        );
        res.status(200).json(players);
        return;
      }

      const players = await this.playerService.getAllPlayers(limit, offset);
      res.status(200).json(players);
    } catch (error) {
      next(error);
    }
  };

  getPlayerById = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const playerId = requirePlayerId(req);

      const player = await this.playerService.getPlayerById(playerId);
      res.status(200).json(player);
    } catch (error) {
      next(error);
    }
  };

  searchPlayers = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = req.query.q as string;
      const position = req.query.position as string;
      const team = req.query.team as string;
      const playerType = req.query.playerType as 'nfl' | 'college' | undefined;

      if (!query || query.trim().length === 0) {
        res.status(200).json([]);
        return;
      }

      const players = await this.playerService.searchPlayers(query.trim(), position, team, playerType);
      res.status(200).json(players);
    } catch (error) {
      next(error);
    }
  };

  syncPlayers = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      // In production, you might want to protect this with an API key
      const result = await this.playerService.syncPlayersFromSleeper();
      res.status(200).json({
        message: 'Player sync completed',
        ...result,
      });
    } catch (error) {
      next(error);
    }
  };

  getNflState = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const state = await this.playerService.getNflState();
      res.status(200).json(state);
    } catch (error) {
      next(error);
    }
  };

  syncCollegePlayers = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const year = req.query.year ? parseInt(req.query.year as string, 10) : undefined;
      const result = await this.playerService.syncCollegePlayersFromCFBD(year);
      res.status(200).json({
        message: 'College player sync completed',
        ...result,
      });
    } catch (error) {
      next(error);
    }
  };

  // ========== NEWS ENDPOINTS (Stream A: A1.5) ==========

  /**
   * GET /api/players/:playerId/news
   * Get news for a specific player
   */
  getPlayerNews = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!this.newsRepo) {
        return res.status(503).json({ error: 'News service not initialized' });
      }

      const playerId = requirePlayerId(req);
      const limit = parseInt(req.query.limit as string) || 10;

      const news = await this.newsRepo.getNewsByPlayer(playerId, limit);
      res.status(200).json(news.map(playerNewsToResponse));
    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /api/players/news/latest
   * Get latest news across all players (league-wide feed)
   */
  getLatestNews = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!this.newsRepo) {
        return res.status(503).json({ error: 'News service not initialized' });
      }

      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      const news = await this.newsRepo.getLatestNews(limit, offset);
      res.status(200).json(news.map(playerNewsToResponse));
    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /api/players/news/breaking
   * Get breaking news (critical/high impact)
   */
  getBreakingNews = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!this.newsRepo) {
        return res.status(503).json({ error: 'News service not initialized' });
      }

      // Default to last 24 hours
      const hoursBack = parseInt(req.query.hours as string) || 24;
      const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
      const limit = parseInt(req.query.limit as string) || 20;

      const news = await this.newsRepo.getBreakingNews(since, limit);
      res.status(200).json(news.map(playerNewsToResponse));
    } catch (error) {
      next(error);
    }
  };

  // ========== STATS ENDPOINTS (Stream B: B1.1) ==========

  /**
   * GET /api/players/:playerId/stats/:season
   * Get season stats for a player
   */
  getPlayerSeasonStats = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!this.statsService) {
        return res.status(503).json({ error: 'Stats service not initialized' });
      }

      const playerId = requirePlayerId(req);
      const season = Array.isArray(req.params.season) ? req.params.season[0] : req.params.season;

      const stats = await this.statsService.calculateSeasonTotals(playerId, season);
      if (!stats) {
        return res.status(404).json({ error: 'No stats found for this player/season' });
      }

      res.status(200).json(stats);
    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /api/players/:playerId/gamelogs
   * Get recent game logs for a player
   */
  getPlayerGameLogs = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!this.statsService) {
        return res.status(503).json({ error: 'Stats service not initialized' });
      }

      const playerId = requirePlayerId(req);
      const season = (req.query.season as string) || '2024'; // Default to current season
      const limit = parseInt(req.query.limit as string) || 10;

      const gameLogs = await this.statsService.getGameLogs(playerId, season, limit);
      res.status(200).json(gameLogs);
    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /api/players/:playerId/projections
   * Get weekly projection for a player
   */
  getPlayerProjection = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!this.statsService) {
        return res.status(503).json({ error: 'Stats service not initialized' });
      }

      const playerId = requirePlayerId(req);
      const season = (req.query.season as string) || '2024';
      const week = parseInt(req.query.week as string);

      if (!week || week < 1 || week > 18) {
        return res.status(400).json({ error: 'Invalid week parameter (1-18)' });
      }

      const projection = await this.statsService.getWeeklyProjection(playerId, season, week);
      if (projection === null) {
        return res.status(404).json({ error: 'No projection found for this player/week' });
      }

      res.status(200).json({ player_id: playerId, season, week, projected_pts_ppr: projection });
    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /api/players/:playerId/trends
   * Get performance trend for a player
   */
  getPlayerTrends = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!this.statsService) {
        return res.status(503).json({ error: 'Stats service not initialized' });
      }

      const playerId = requirePlayerId(req);
      const season = (req.query.season as string) || '2024';
      const weeks = parseInt(req.query.weeks as string) || 8;

      const trend = await this.statsService.getStatTrends(playerId, season, weeks);
      if (!trend) {
        return res.status(404).json({ error: 'No trend data found for this player' });
      }

      res.status(200).json(trend);
    } catch (error) {
      next(error);
    }
  };
}
