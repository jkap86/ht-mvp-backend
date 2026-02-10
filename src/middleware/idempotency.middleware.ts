import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { AuthRequest } from './auth.middleware';
import { logger } from '../config/logger.config';

/**
 * Idempotency middleware factory.
 * Checks x-idempotency-key header against idempotency_keys table.
 * If key exists for this user+endpoint, returns cached response.
 * If not, wraps res.json to capture the response and store it.
 */
export function idempotencyMiddleware(pool: Pool) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;

    // No key provided — skip idempotency check
    if (!idempotencyKey) {
      return next();
    }

    // Only apply to mutating methods
    if (req.method === 'GET' || req.method === 'OPTIONS' || req.method === 'HEAD') {
      return next();
    }

    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      // Not authenticated yet — skip (auth middleware hasn't run or route is public)
      return next();
    }

    const endpoint = req.originalUrl;
    const method = req.method;

    try {
      // Check for existing response
      const existing = await pool.query(
        `SELECT response_status, response_body FROM idempotency_keys
         WHERE idempotency_key = $1 AND endpoint = $2 AND user_id = $3
         AND expires_at > NOW()`,
        [idempotencyKey, endpoint, userId]
      );

      if (existing.rows.length > 0) {
        const { response_status, response_body } = existing.rows[0];
        res.status(response_status).json(response_body);
        return;
      }

      // Wrap res.json to capture the response
      const originalJson = res.json.bind(res);
      res.json = function (body: any): Response {
        // Store the response asynchronously (fire-and-forget)
        pool.query(
          `INSERT INTO idempotency_keys (idempotency_key, endpoint, method, user_id, response_status, response_body)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (idempotency_key, endpoint, user_id) DO NOTHING`,
          [idempotencyKey, endpoint, method, userId, res.statusCode, JSON.stringify(body)]
        ).catch((err) => {
          logger.warn('Failed to store idempotency key', { err: err.message, key: idempotencyKey });
        });

        return originalJson(body);
      };

      next();
    } catch (err) {
      // On failure, pass through without idempotency protection
      logger.warn('Idempotency check failed', { error: (err as Error).message });
      next();
    }
  };
}
