import { Request, Response, NextFunction } from 'express';
import { PlayerService } from './players.service';
import { AuthRequest } from '../../middleware/auth.middleware';
import { requirePlayerId } from '../../utils/controller-helpers';

export class PlayerController {
  constructor(private readonly playerService: PlayerService) {}

  getAllPlayers = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const offset = parseInt(req.query.offset as string) || 0;

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

      if (!query || query.trim().length === 0) {
        res.status(200).json([]);
        return;
      }

      const players = await this.playerService.searchPlayers(query.trim(), position, team);
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
}
