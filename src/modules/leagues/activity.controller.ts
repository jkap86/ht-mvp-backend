/**
 * Activity Feed Controller
 * Stream D: Transaction Activity Feed (D1.2)
 */

import { Request, Response, NextFunction } from 'express';
import { ActivityService, ActivityType } from './activity.service';

export class ActivityController {
  constructor(private readonly activityService: ActivityService) {}

  /**
   * GET /api/leagues/:leagueId/activity
   * Get activity feed for a league
   */
  getLeagueActivity = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const leagueId = parseInt(Array.isArray(req.params.leagueId) ? req.params.leagueId[0] : req.params.leagueId);
      const type = (req.query.type as ActivityType | 'all') || 'all';
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;
      const week = req.query.week ? parseInt(req.query.week as string) : undefined;

      if (isNaN(leagueId)) {
        return res.status(400).json({ error: 'Invalid leagueId' });
      }

      const activities = await this.activityService.getLeagueActivity(leagueId, {
        type,
        limit,
        offset,
        week,
      });

      res.status(200).json(activities);
    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /api/leagues/:leagueId/activity/week/:week
   * Get activity for a specific week
   */
  getWeekActivity = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const leagueId = parseInt(Array.isArray(req.params.leagueId) ? req.params.leagueId[0] : req.params.leagueId);
      const week = parseInt(Array.isArray(req.params.week) ? req.params.week[0] : req.params.week);
      const type = (req.query.type as ActivityType | 'all') || 'all';
      const limit = parseInt(req.query.limit as string) || 50;

      if (isNaN(leagueId) || isNaN(week)) {
        return res.status(400).json({ error: 'Invalid leagueId or week' });
      }

      const activities = await this.activityService.getLeagueActivity(leagueId, {
        type,
        limit,
        week,
      });

      res.status(200).json(activities);
    } catch (error) {
      next(error);
    }
  };

  /**
   * GET /api/rosters/:rosterId/activity
   * Get activity for a specific roster (team)
   */
  getRosterActivity = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rosterId = parseInt(Array.isArray(req.params.rosterId) ? req.params.rosterId[0] : req.params.rosterId);
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      if (isNaN(rosterId)) {
        return res.status(400).json({ error: 'Invalid rosterId' });
      }

      const activities = await this.activityService.getRosterActivity(rosterId, limit, offset);
      res.status(200).json(activities);
    } catch (error) {
      next(error);
    }
  };
}
