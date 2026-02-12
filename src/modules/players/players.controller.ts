import { Request, Response } from 'express';
import { PlayerService } from './players.service';
import { AuthRequest } from '../../middleware/auth.middleware';
import { requirePlayerId } from '../../utils/controller-helpers';
import { NewsRepository } from './news.repository';
import { StatsService } from './stats.service';
import { playerNewsToResponse } from './news.model';
import { Pool } from 'pg';
import {
  ServiceUnavailableException,
  NotFoundException,
} from '../../utils/exceptions';
import {
  PlayerQueryInput,
  PlayerSearchInput,
  SyncCollegeInput,
  PlayerNewsInput,
  LatestNewsInput,
  BreakingNewsInput,
  GameLogsInput,
  ProjectionInput,
  TrendsInput,
} from './players.schemas';

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

  getAllPlayers = async (req: Request, res: Response) => {
    const { limit, offset, q, position, team, playerType, playerPool: playerPoolParam } =
      req.query as unknown as PlayerQueryInput;

    const playerPool = playerPoolParam
      ? (playerPoolParam.split(',') as ('veteran' | 'rookie' | 'college')[])
      : undefined;

    if (q || position || team || playerType || playerPool) {
      const players = await this.playerService.searchPlayers(
        q || '',
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
  };

  getPlayerById = async (req: Request, res: Response) => {
    const playerId = requirePlayerId(req);

    const player = await this.playerService.getPlayerById(playerId);
    res.status(200).json(player);
  };

  searchPlayers = async (req: Request, res: Response) => {
    const { q, position, team, playerType } = req.query as unknown as PlayerSearchInput;

    if (!q || q.trim().length === 0) {
      res.status(200).json([]);
      return;
    }

    const players = await this.playerService.searchPlayers(q.trim(), position, team, playerType);
    res.status(200).json(players);
  };

  syncPlayers = async (req: AuthRequest, res: Response) => {
    const result = await this.playerService.syncPlayersFromSleeper();
    res.status(200).json({
      message: 'Player sync completed',
      ...result,
    });
  };

  getNflState = async (req: Request, res: Response) => {
    const state = await this.playerService.getNflState();
    res.status(200).json(state);
  };

  syncCollegePlayers = async (req: AuthRequest, res: Response) => {
    const { year } = req.query as unknown as SyncCollegeInput;
    const result = await this.playerService.syncCollegePlayersFromCFBD(year);
    res.status(200).json({
      message: 'College player sync completed',
      ...result,
    });
  };

  getPlayerNews = async (req: Request, res: Response) => {
    if (!this.newsRepo) {
      throw new ServiceUnavailableException('News service not initialized');
    }

    const playerId = requirePlayerId(req);
    const { limit } = req.query as unknown as PlayerNewsInput;

    const news = await this.newsRepo.getNewsByPlayer(playerId, limit);
    res.status(200).json(news.map(playerNewsToResponse));
  };

  getLatestNews = async (req: Request, res: Response) => {
    if (!this.newsRepo) {
      throw new ServiceUnavailableException('News service not initialized');
    }

    const { limit, offset } = req.query as unknown as LatestNewsInput;

    const news = await this.newsRepo.getLatestNews(limit, offset);
    res.status(200).json(news.map(playerNewsToResponse));
  };

  getBreakingNews = async (req: Request, res: Response) => {
    if (!this.newsRepo) {
      throw new ServiceUnavailableException('News service not initialized');
    }

    const { hours, limit } = req.query as unknown as BreakingNewsInput;
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const news = await this.newsRepo.getBreakingNews(since, limit);
    res.status(200).json(news.map(playerNewsToResponse));
  };

  getPlayerSeasonStats = async (req: Request, res: Response) => {
    if (!this.statsService) {
      throw new ServiceUnavailableException('Stats service not initialized');
    }

    const playerId = requirePlayerId(req);
    const season = Array.isArray(req.params.season) ? req.params.season[0] : req.params.season;

    const stats = await this.statsService.calculateSeasonTotals(playerId, season);
    if (!stats) {
      throw new NotFoundException('No stats found for this player/season');
    }

    res.status(200).json(stats);
  };

  getPlayerGameLogs = async (req: Request, res: Response) => {
    if (!this.statsService) {
      throw new ServiceUnavailableException('Stats service not initialized');
    }

    const playerId = requirePlayerId(req);
    const { season, limit } = req.query as unknown as GameLogsInput;

    const gameLogs = await this.statsService.getGameLogs(playerId, season, limit);
    res.status(200).json(gameLogs);
  };

  getPlayerProjection = async (req: Request, res: Response) => {
    if (!this.statsService) {
      throw new ServiceUnavailableException('Stats service not initialized');
    }

    const playerId = requirePlayerId(req);
    const { season, week } = req.query as unknown as ProjectionInput;

    const projection = await this.statsService.getWeeklyProjection(playerId, season, week);
    if (projection === null) {
      throw new NotFoundException('No projection found for this player/week');
    }

    res.status(200).json({ player_id: playerId, season, week, projected_pts_ppr: projection });
  };

  getPlayerTrends = async (req: Request, res: Response) => {
    if (!this.statsService) {
      throw new ServiceUnavailableException('Stats service not initialized');
    }

    const playerId = requirePlayerId(req);
    const { season, weeks } = req.query as unknown as TrendsInput;

    const trend = await this.statsService.getStatTrends(playerId, season, weeks);
    if (!trend) {
      throw new NotFoundException('No trend data found for this player');
    }

    res.status(200).json(trend);
  };
}
