/**
 * Activity Feed Controller
 * Stream D: Transaction Activity Feed (D1.2)
 */

import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { requireUserId, requireLeagueId } from '../../utils/controller-helpers';
import { ForbiddenException } from '../../utils/exceptions';
import { ActivityService, ActivityType } from './activity.service';
import { AuthorizationService } from '../auth/authorization.service';
import { RosterRepository } from '../rosters/roster.repository';

export class ActivityController {
  constructor(
    private readonly activityService: ActivityService,
    private readonly authorizationService: AuthorizationService,
    private readonly rosterRepo: RosterRepository
  ) {}

  /**
   * GET /api/leagues/:leagueId/activity
   * Get activity feed for a league
   */
  getLeagueActivity = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const type = (req.query.type as ActivityType | 'all') || 'all';
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const week = req.query.week ? parseInt(req.query.week as string, 10) : undefined;

    await this.authorizationService.ensureLeagueMember(leagueId, userId);

    const activities = await this.activityService.getLeagueActivity(leagueId, {
      type,
      limit,
      offset,
      week,
    });

    res.status(200).json(activities);
  };

  /**
   * GET /api/leagues/:leagueId/activity/week/:week
   * Get activity for a specific week
   */
  getWeekActivity = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const leagueId = requireLeagueId(req);
    const week = parseInt(Array.isArray(req.params.week) ? req.params.week[0] : req.params.week, 10);
    const type = (req.query.type as ActivityType | 'all') || 'all';
    const limit = parseInt(req.query.limit as string, 10) || 50;

    if (isNaN(week)) {
      return res.status(400).json({ error: 'Invalid week' });
    }

    await this.authorizationService.ensureLeagueMember(leagueId, userId);

    const activities = await this.activityService.getLeagueActivity(leagueId, {
      type,
      limit,
      week,
    });

    res.status(200).json(activities);
  };

  /**
   * GET /api/rosters/:rosterId/activity
   * Get activity for a specific roster (team)
   */
  getRosterActivity = async (req: AuthRequest, res: Response) => {
    const userId = requireUserId(req);
    const rosterId = parseInt(Array.isArray(req.params.rosterId) ? req.params.rosterId[0] : req.params.rosterId, 10);
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const offset = parseInt(req.query.offset as string, 10) || 0;

    if (isNaN(rosterId)) {
      return res.status(400).json({ error: 'Invalid rosterId' });
    }

    const roster = await this.rosterRepo.findById(rosterId);
    if (!roster) {
      throw new ForbiddenException('You are not authorized to view this roster activity');
    }

    await this.authorizationService.ensureLeagueMember(roster.leagueId, userId);

    const activities = await this.activityService.getRosterActivity(rosterId, limit, offset);
    res.status(200).json(activities);
  };
}
