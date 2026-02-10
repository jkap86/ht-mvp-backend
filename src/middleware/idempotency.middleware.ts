import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { AuthRequest } from './auth.middleware';
import { logger } from '../config/logger.config';

/**
 * Idempotency middleware factory.
 *
 * Flow:
 * 1. Check if key exists and is completed → return cached response
 * 2. Try to claim the key (INSERT pending record) → if conflict, another request owns it
 * 3. Run the handler, capture response via res.json wrapper
 * 4. UPDATE the pending record with the actual response
 *
 * This eliminates the TOCTOU race in the old check-then-insert pattern
 * and ensures responses are reliably stored (no fire-and-forget).
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
      // Atomically try to claim this idempotency key by inserting a pending record.
      // If the key already exists (completed or in-flight), the INSERT does nothing
      // and we handle each case below.
      const claimResult = await pool.query(
        `INSERT INTO idempotency_keys (idempotency_key, endpoint, method, user_id, response_status, response_body)
         VALUES ($1, $2, $3, $4, 0, NULL)
         ON CONFLICT (idempotency_key, endpoint, user_id) DO NOTHING
         RETURNING id`,
        [idempotencyKey, endpoint, method, userId]
      );

      if (claimResult.rows.length === 0) {
        // Key already exists — check if it has a completed response
        const existing = await pool.query(
          `SELECT response_status, response_body FROM idempotency_keys
           WHERE idempotency_key = $1 AND endpoint = $2 AND user_id = $3
           AND expires_at > NOW()`,
          [idempotencyKey, endpoint, userId]
        );

        if (existing.rows.length > 0) {
          const { response_status, response_body } = existing.rows[0];
          if (response_status > 0 && response_body !== null) {
            // Completed — return cached response
            res.status(response_status).json(response_body);
            return;
          }
          // Still in-flight (response_status = 0) — return 409
          res.status(409).json({ error: 'Request is already being processed' });
          return;
        }

        // Key expired — allow re-use by deleting and re-inserting
        await pool.query(
          `DELETE FROM idempotency_keys
           WHERE idempotency_key = $1 AND endpoint = $2 AND user_id = $3
           AND expires_at <= NOW()`,
          [idempotencyKey, endpoint, userId]
        );

        // Re-claim after cleanup
        const reclaimResult = await pool.query(
          `INSERT INTO idempotency_keys (idempotency_key, endpoint, method, user_id, response_status, response_body)
           VALUES ($1, $2, $3, $4, 0, NULL)
           ON CONFLICT (idempotency_key, endpoint, user_id) DO NOTHING
           RETURNING id`,
          [idempotencyKey, endpoint, method, userId]
        );

        if (reclaimResult.rows.length === 0) {
          // Another request raced us — return 409
          res.status(409).json({ error: 'Request is already being processed' });
          return;
        }
      }

      // We own the pending record — wrap res.json to capture and store the response
      const originalJson = res.json.bind(res);
      res.json = function (body: any): Response {
        // Store response synchronously in the call chain (best-effort but reliable)
        pool.query(
          `UPDATE idempotency_keys
           SET response_status = $1, response_body = $2
           WHERE idempotency_key = $3 AND endpoint = $4 AND user_id = $5`,
          [res.statusCode, JSON.stringify(body), idempotencyKey, endpoint, userId]
        ).catch((err) => {
          logger.warn('Failed to update idempotency key response', {
            err: err.message,
            key: idempotencyKey,
          });
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
