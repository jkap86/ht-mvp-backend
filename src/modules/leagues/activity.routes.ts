/**
 * Activity Feed Routes
 * Stream D: Transaction Activity Feed
 */

import { Router } from 'express';
import { Pool } from 'pg';
import { ActivityController } from './activity.controller';
import { ActivityService } from './activity.service';
import { authMiddleware } from '../../middleware/auth.middleware';
import { apiReadLimiter } from '../../middleware/rate-limit.middleware';
import { container, KEYS } from '../../container';

const pool = container.resolve<Pool>(KEYS.POOL);
const activityService = new ActivityService(pool);
const activityController = new ActivityController(activityService);

const router = Router();

// All activity routes require authentication
router.use(authMiddleware);

// GET /api/leagues/:leagueId/activity - Get league activity feed
router.get('/:leagueId/activity', apiReadLimiter, activityController.getLeagueActivity);

// GET /api/leagues/:leagueId/activity/week/:week - Get week-specific activity
router.get('/:leagueId/activity/week/:week', apiReadLimiter, activityController.getWeekActivity);

// GET /api/rosters/:rosterId/activity - Get roster-specific activity
router.get('/rosters/:rosterId/activity', apiReadLimiter, activityController.getRosterActivity);

export default router;
