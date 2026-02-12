import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { LeagueService } from './leagues.service';
import { RosterService } from './roster.service';
import { DashboardService } from './dashboard.service';
import { ValidationException, ForbiddenException } from '../../utils/exceptions';
import { requireUserId, requireLeagueId } from '../../utils/controller-helpers';
import { deleteLeagueSchema, seasonControlsSchema, UpdateLeagueInput } from './leagues.schemas';
import type { LeagueMode, LeagueSettings } from './leagues.model';

export class LeagueController {
  constructor(
    private readonly leagueService: LeagueService,
    private readonly rosterService?: RosterService,
    private readonly dashboardService?: DashboardService
  ) {}

  getMyLeagues = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);
    const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

    const leagues = await this.leagueService.getUserLeagues(userId, limit, offset);
    res.status(200).json(leagues);
  };

  getLeague = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);

    const league = await this.leagueService.getLeagueById(leagueId, userId);
    res.status(200).json(league);
  };

  createLeague = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;

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
      userId,
      idempotencyKey
    );

    res.status(201).json(league);
  };

  joinLeague = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);

    if (!this.rosterService) {
      throw new ValidationException('Roster service not available');
    }
    const result = await this.rosterService.joinLeague(leagueId, userId);
    res.status(200).json(result);
  };

  updateLeague = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);

    // req.body is already validated and stripped by validateRequest(updateLeagueSchema)
    const body = req.body as UpdateLeagueInput;

    const updates: {
      name?: string;
      mode?: LeagueMode;
      settings?: Record<string, any>;
      leagueSettings?: LeagueSettings;
      scoringSettings?: Record<string, any>;
      status?: string;
      isPublic?: boolean;
      totalRosters?: number;
    } = {};

    if (body.name !== undefined) updates.name = body.name;
    if (body.mode !== undefined) updates.mode = body.mode;
    if (body.settings !== undefined) updates.settings = body.settings;
    if (body.league_settings !== undefined) updates.leagueSettings = body.league_settings;
    if (body.scoring_settings !== undefined) updates.scoringSettings = body.scoring_settings;
    if (body.status !== undefined) updates.status = body.status;
    if (body.is_public !== undefined) updates.isPublic = body.is_public;
    if (body.total_rosters !== undefined) updates.totalRosters = body.total_rosters;

    const league = await this.leagueService.updateLeague(leagueId, userId, updates);
    res.status(200).json(league);
  };

  reinstateMember = async (req: AuthRequest, res: Response) => {
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
  };

  deleteLeague = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const { confirmationName } = deleteLeagueSchema.parse(req.body);

    await this.leagueService.deleteLeague(leagueId, userId, confirmationName);
    res.status(200).json({ message: 'League deleted successfully' });
  };

  updateSeasonControls = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const input = seasonControlsSchema.parse(req.body);

    const league = await this.leagueService.updateSeasonControls(leagueId, userId, input);
    res.status(200).json(league);
  };

  getMembers = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);

    if (!this.rosterService) {
      throw new ValidationException('Roster service not available');
    }
    const members = await this.rosterService.getLeagueMembers(leagueId, userId);
    res.status(200).json(members);
  };

  kickMember = async (req: AuthRequest, res: Response) => {
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
  };

  devAddUsers = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);

    // Even in development, require commissioner access to prevent abuse
    const isCommissioner = await this.leagueService.isCommissioner(leagueId, userId);
    if (!isCommissioner) {
      throw new ForbiddenException('Only the commissioner can add users');
    }

    if (!this.rosterService) {
      throw new ValidationException('Roster service not available');
    }

    const { usernames } = req.body;
    if (!Array.isArray(usernames) || usernames.length === 0) {
      throw new ValidationException('usernames must be a non-empty array');
    }

    const results = await this.rosterService.devBulkAddUsers(leagueId, usernames);
    res.status(200).json({ results });
  };

  discoverLeagues = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);
    const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

    const leagues = await this.leagueService.discoverPublicLeagues(userId, limit, offset);
    res.status(200).json(leagues);
  };

  joinPublicLeague = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;

    const league = await this.leagueService.joinPublicLeague(leagueId, userId, idempotencyKey);
    res.status(200).json(league);
  };

  resetLeague = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;

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
      },
      idempotencyKey
    );

    res.status(200).json(league);
  };

  getDashboard = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);

    if (!this.dashboardService) {
      throw new ValidationException('Dashboard service not available');
    }
    const dashboard = await this.dashboardService.getDashboardSummary(leagueId, userId);
    res.status(200).json(dashboard);
  };
}
