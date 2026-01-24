import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { LeagueService } from './leagues.service';
import { ValidationException } from '../../utils/exceptions';
import { requireUserId, requireLeagueId } from '../../utils/controller-helpers';

export class LeagueController {
  constructor(private readonly leagueService: LeagueService) {}

  getMyLeagues = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const limit = parseInt(req.query.limit as string, 10) || 50;
      const offset = parseInt(req.query.offset as string, 10) || 0;

      const leagues = await this.leagueService.getUserLeagues(userId, limit, offset);
      res.status(200).json(leagues);
    } catch (error) {
      next(error);
    }
  };

  getLeague = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);

      const league = await this.leagueService.getLeagueById(leagueId, userId);
      res.status(200).json(league);
    } catch (error) {
      next(error);
    }
  };

  createLeague = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);

      const { name, season, total_rosters = 12, settings = {}, scoring_settings = {} } = req.body;

      const league = await this.leagueService.createLeague(
        {
          name,
          season,
          totalRosters: total_rosters,
          settings,
          scoringSettings: scoring_settings,
        },
        userId
      );

      res.status(201).json(league);
    } catch (error) {
      next(error);
    }
  };

  joinLeague = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);

      const result = await this.leagueService.joinLeague(leagueId, userId);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  };

  joinLeagueByInviteCode = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const inviteCode = req.params.inviteCode as string;

      if (!inviteCode || typeof inviteCode !== 'string' || inviteCode.length !== 8) {
        throw new ValidationException('Invalid invite code format');
      }

      const league = await this.leagueService.joinLeagueByInviteCode(inviteCode, userId);
      res.status(200).json(league);
    } catch (error) {
      next(error);
    }
  };

  updateLeague = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);

      const updates: any = {};
      if (req.body.name) updates.name = req.body.name;
      if (req.body.settings) updates.settings = req.body.settings;
      if (req.body.scoring_settings) updates.scoringSettings = req.body.scoring_settings;
      if (req.body.status) updates.status = req.body.status;

      const league = await this.leagueService.updateLeague(leagueId, userId, updates);
      res.status(200).json(league);
    } catch (error) {
      next(error);
    }
  };

  deleteLeague = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);

      await this.leagueService.deleteLeague(leagueId, userId);
      res.status(200).json({ message: 'League deleted successfully' });
    } catch (error) {
      next(error);
    }
  };

  getMembers = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);

      const members = await this.leagueService.getLeagueMembers(leagueId, userId);
      res.status(200).json(members);
    } catch (error) {
      next(error);
    }
  };

  devAddUsers = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const leagueId = requireLeagueId(req);

      const { usernames } = req.body;
      if (!Array.isArray(usernames) || usernames.length === 0) {
        throw new ValidationException('usernames must be a non-empty array');
      }

      const results = await this.leagueService.devBulkAddUsers(leagueId, usernames);
      res.status(200).json({ results });
    } catch (error) {
      next(error);
    }
  };
}
