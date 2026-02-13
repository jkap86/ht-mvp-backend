/**
 * Season Write Guard Middleware
 *
 * Rejects write operations (POST/PUT/PATCH/DELETE) to completed seasons.
 * Allows reads (GET) unconditionally.
 * Must be applied AFTER resolveSeasonContext middleware.
 */

import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { container, KEYS } from '../container';

export async function seasonWriteGuard(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET') return next();

  const leagueSeasonId = req.leagueSeasonId;
  if (!leagueSeasonId) return next();

  try {
    const pool = container.resolve<Pool>(KEYS.POOL);
    const result = await pool.query(
      'SELECT status FROM league_seasons WHERE id = $1',
      [leagueSeasonId]
    );

    if (result.rows[0]?.status === 'completed') {
      return res.status(409).json({
        error: {
          code: 'SEASON_COMPLETED',
          message: 'Season is completed. Cannot modify data for a past season.',
        },
      });
    }

    next();
  } catch (err) {
    next(err);
  }
}
