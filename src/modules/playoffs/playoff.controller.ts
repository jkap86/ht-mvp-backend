import { Response, NextFunction } from 'express';
import { PlayoffService } from './playoff.service';
import { playoffBracketViewToResponse } from './playoff.model';
import { AuthRequest } from '../../middleware/auth.middleware';
import { requireUserId, requireLeagueId } from '../../utils/controller-helpers';
import { ValidationException } from '../../utils/exceptions';

export class PlayoffController {
  constructor(private readonly playoffService: PlayoffService) {}

  /**
   * POST /api/leagues/:leagueId/playoffs/generate
   * Generate playoff bracket (commissioner only)
   */
  generateBracket = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);

      const { playoff_teams, start_week } = req.body;

      if (!playoff_teams || !start_week) {
        throw new ValidationException('playoff_teams and start_week are required');
      }

      const playoffTeams = parseInt(playoff_teams, 10);
      const startWeek = parseInt(start_week, 10);

      if (isNaN(playoffTeams) || isNaN(startWeek)) {
        throw new ValidationException('playoff_teams and start_week must be numbers');
      }

      const bracketView = await this.playoffService.generatePlayoffBracket(leagueId, userId, {
        playoffTeams,
        startWeek,
      });

      res.status(201).json(playoffBracketViewToResponse(bracketView));
    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /api/leagues/:leagueId/playoffs/bracket
   * Get playoff bracket
   */
  getBracket = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);

      const bracketView = await this.playoffService.getPlayoffBracket(leagueId, userId);

      if (!bracketView) {
        res.status(200).json({ bracket: null, seeds: [], rounds: [], champion: null });
        return;
      }

      res.status(200).json(playoffBracketViewToResponse(bracketView));
    } catch (error) {
      next(error);
    }
  };

  /**
   * POST /api/leagues/:leagueId/playoffs/advance
   * Advance winners to next round (commissioner only)
   */
  advanceWinners = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);

      const { week } = req.body;

      if (!week) {
        throw new ValidationException('week is required');
      }

      const weekNum = parseInt(week, 10);
      if (isNaN(weekNum)) {
        throw new ValidationException('week must be a number');
      }

      const bracketView = await this.playoffService.advanceWinners(leagueId, weekNum, userId);

      res.status(200).json(playoffBracketViewToResponse(bracketView));
    } catch (error) {
      next(error);
    }
  };
}
