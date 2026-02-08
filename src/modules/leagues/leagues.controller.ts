import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { LeagueService } from './leagues.service';
import { RosterService } from './roster.service';
import { DashboardService } from './dashboard.service';
import { ValidationException } from '../../utils/exceptions';
import { requireUserId, requireLeagueId } from '../../utils/controller-helpers';

export class LeagueController {
  constructor(
    private readonly leagueService: LeagueService,
    private readonly rosterService?: RosterService,
    private readonly dashboardService?: DashboardService
  ) {}

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

      const {
        name,
        season,
        total_rosters = 12,
        settings = {},
        scoring_settings = {},
        is_public = false,
        mode,
        league_settings,
        draft_structure,
      } = req.body;

      const league = await this.leagueService.createLeague(
        {
          name,
          season,
          totalRosters: total_rosters,
          settings,
          scoringSettings: scoring_settings,
          isPublic: is_public,
          mode,
          leagueSettings: league_settings,
          draftStructure: draft_structure,
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

      if (!this.rosterService) {
        throw new ValidationException('Roster service not available');
      }
      const result = await this.rosterService.joinLeague(leagueId, userId);
      res.status(200).json(result);
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
      if (req.body.mode) updates.mode = req.body.mode;
      if (req.body.settings) updates.settings = req.body.settings;
      if (req.body.league_settings) updates.leagueSettings = req.body.league_settings;
      if (req.body.scoring_settings) updates.scoringSettings = req.body.scoring_settings;
      if (req.body.status) updates.status = req.body.status;
      if (req.body.is_public !== undefined) updates.isPublic = req.body.is_public;
      if (req.body.total_rosters !== undefined) updates.totalRosters = req.body.total_rosters;

      const league = await this.leagueService.updateLeague(leagueId, userId, updates);
      res.status(200).json(league);
    } catch (error) {
      next(error);
    }
  };

  reinstateMember = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const rosterId = parseInt(req.params.rosterId as string, 10);

      if (isNaN(rosterId)) {
        throw new ValidationException('Invalid roster ID');
      }

      if (!this.rosterService) {
        throw new ValidationException('Roster service not available');
      }
      const result = await this.rosterService.reinstateMember(leagueId, rosterId, userId);
      res.status(200).json(result);
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

      if (!this.rosterService) {
        throw new ValidationException('Roster service not available');
      }
      const members = await this.rosterService.getLeagueMembers(leagueId, userId);
      res.status(200).json(members);
    } catch (error) {
      next(error);
    }
  };

  kickMember = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);
      const rosterId = parseInt(req.params.rosterId as string, 10);

      if (isNaN(rosterId)) {
        throw new ValidationException('Invalid roster ID');
      }

      if (!this.rosterService) {
        throw new ValidationException('Roster service not available');
      }
      const result = await this.rosterService.kickMember(leagueId, rosterId, userId);
      res.status(200).json(result);
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

      if (!this.rosterService) {
        throw new ValidationException('Roster service not available');
      }
      const results = await this.rosterService.devBulkAddUsers(leagueId, usernames);
      res.status(200).json({ results });
    } catch (error) {
      next(error);
    }
  };

  discoverLeagues = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const limit = parseInt(req.query.limit as string, 10) || 50;
      const offset = parseInt(req.query.offset as string, 10) || 0;

      const leagues = await this.leagueService.discoverPublicLeagues(userId, limit, offset);
      res.status(200).json(leagues);
    } catch (error) {
      next(error);
    }
  };

  joinPublicLeague = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);

      const league = await this.leagueService.joinPublicLeague(leagueId, userId);
      res.status(200).json(league);
    } catch (error) {
      next(error);
    }
  };

  resetLeague = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);

      const { new_season, keep_members, clear_chat, confirmation_name } = req.body;

      if (!new_season || !confirmation_name) {
        throw new ValidationException('new_season and confirmation_name are required');
      }

      const league = await this.leagueService.resetLeagueForNewSeason(
        leagueId,
        userId,
        new_season,
        {
          keepMembers: keep_members ?? false,
          clearChat: clear_chat ?? true,
          confirmationName: confirmation_name,
        }
      );

      res.status(200).json(league);
    } catch (error) {
      next(error);
    }
  };

  getDashboard = async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const userId = requireUserId(req);
      const leagueId = requireLeagueId(req);

      if (!this.dashboardService) {
        throw new ValidationException('Dashboard service not available');
      }
      const dashboard = await this.dashboardService.getDashboardSummary(leagueId, userId);
      res.status(200).json(dashboard);
    } catch (error) {
      next(error);
    }
  };
}
