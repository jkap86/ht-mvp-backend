/**
 * Season Context Middleware
 *
 * Resolves the active leagueSeasonId for routes with :leagueId param
 * and attaches it to the request for downstream handlers.
 */

import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { getActiveLeagueSeasonId } from '../shared/season-context';
import { container, KEYS } from '../container';

// Extend Express Request globally so all controllers can access leagueSeasonId
declare global {
  namespace Express {
    interface Request {
      leagueSeasonId?: number;
    }
  }
}

export async function resolveSeasonContext(req: Request, res: Response, next: NextFunction) {
  const leagueId = parseInt(String(req.params.leagueId), 10);
  if (!leagueId || isNaN(leagueId)) return next();

  try {
    const pool = container.resolve<Pool>(KEYS.POOL);
    const leagueSeasonId = await getActiveLeagueSeasonId(pool, leagueId);
    req.leagueSeasonId = leagueSeasonId;
    next();
  } catch (err) {
    next(err);
  }
}
