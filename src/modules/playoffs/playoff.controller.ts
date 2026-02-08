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
   *
   * Body params:
   * - playoff_teams (required): 4, 6, or 8
   * - start_week (required): week number to start playoffs
   * - enable_third_place_game (optional): boolean, enable 3rd place game
   * - consolation_type (optional): 'NONE' | 'CONSOLATION'
   * - consolation_teams (optional): 4, 6, or 8 (or null for auto)
   */
  generateBracket = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);

      const {
        playoff_teams,
        start_week,
        enable_third_place_game,
        consolation_type,
        consolation_teams,
      } = req.body;

      if (!playoff_teams || !start_week) {
        throw new ValidationException('playoff_teams and start_week are required');
      }

      const playoffTeams = parseInt(playoff_teams, 10);
      const startWeek = parseInt(start_week, 10);

      if (isNaN(playoffTeams) || isNaN(startWeek)) {
        throw new ValidationException('playoff_teams and start_week must be numbers');
      }

      // Parse optional consolation_teams
      let consolationTeamsNum: number | undefined;
      if (consolation_teams !== undefined && consolation_teams !== null) {
        consolationTeamsNum = parseInt(consolation_teams, 10);
        if (isNaN(consolationTeamsNum)) {
          throw new ValidationException('consolation_teams must be a number');
        }
      }

      const bracketView = await this.playoffService.generatePlayoffBracket(leagueId, userId, {
        playoffTeams,
        startWeek,
        enableThirdPlaceGame: enable_third_place_game === true,
        consolationType: consolation_type ?? 'NONE',
        consolationTeams: consolationTeamsNum,
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
        res.status(200).json({
          bracket: null,
          seeds: [],
          rounds: [],
          champion: null,
          third_place: null,
          consolation: null,
          settings: {
            enable_third_place_game: false,
            consolation_type: 'NONE',
            consolation_teams: null,
          },
        });
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
