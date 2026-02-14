import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { AuthRequest } from './auth.middleware';
import { logger } from '../config/logger.config';

const MAX_RESPONSE_BODY_BYTES = 102_400; // 100KB

/**
 * Idempotency middleware factory.
 *
 * Flow:
 * 1. Guard clauses (no key, GET, no user) -> next()
 * 2. Atomic claim INSERT ... ON CONFLICT DO NOTHING
 * 3. If claim fails -> check existing -> replay or 409
 * 4. If claim succeeds:
 *    a. Set res.locals._idempotencyClaimed = true
 *    b. Wrap res.json to capture body + mark _captured = true
 *    c. Attach res.on('finish') fallback: if !_captured, finalize with statusCode + null body
 *    d. Wrap next() in try/catch for wedge protection
 * 5. On error/close: clean up pending row
 */
export function idempotencyMiddleware(pool: Pool) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;

    // No key provided - skip idempotency check
    if (!idempotencyKey) {
      return next();
    }

    // Reject oversized keys
    if (idempotencyKey.length > 256) {
      res.status(400).json({ error: 'Idempotency key must be 256 characters or fewer' });
      return;
    }

    // Only apply to mutating methods
    if (req.method === 'GET' || req.method === 'OPTIONS' || req.method === 'HEAD') {
      return next();
    }

    const authReq = req as AuthRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      // Not authenticated yet - skip
      return next();
    }

    const endpoint = req.originalUrl;
    const method = req.method;

    try {
      // Atomically try to claim this idempotency key
      const claimResult = await pool.query(
        `INSERT INTO idempotency_keys (idempotency_key, endpoint, method, user_id, response_status, response_body)
         VALUES ($1, $2, $3, $4, 0, NULL)
         ON CONFLICT (idempotency_key, endpoint, user_id) DO NOTHING
         RETURNING id`,
        [idempotencyKey, endpoint, method, userId]
      );

      if (claimResult.rows.length === 0) {
        // Key already exists - check if it has a completed response
        const existing = await pool.query(
          `SELECT response_status, response_body FROM idempotency_keys
           WHERE idempotency_key = $1 AND endpoint = $2 AND user_id = $3
           AND expires_at > NOW()`,
          [idempotencyKey, endpoint, userId]
        );

        if (existing.rows.length > 0) {
          const { response_status, response_body } = existing.rows[0];
          if (response_status > 0) {
            // Completed - replay cached response
            if (response_status === 204) {
              res.status(204).end();
              return;
            }
            if (response_body !== null) {
              // response_body comes back as parsed object from JSONB column
              res.status(response_status).json(response_body);
              return;
            }
            // Non-204 with null body - unusual but handle gracefully
            res.status(response_status).end();
            return;
          }
          // Still in-flight (response_status = 0) - return 409
          res.status(409).json({ error: 'Request is already being processed' });
          return;
        }

        // Key expired - allow re-use by deleting and re-inserting
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
          // Another request raced us
          res.status(409).json({ error: 'Request is already being processed' });
          return;
        }
      }

      // We own the pending record - set up response capture
      res.locals._idempotencyClaimed = true;
      let _captured = false;

      // Wrap res.json to capture JSON responses
      const originalJson = res.json.bind(res);
      res.json = function (body: any): Response {
        _captured = true;

        // Check response body size before storing
        const serialized = JSON.stringify(body);
        const bodySize = Buffer.byteLength(serialized, 'utf8');

        if (bodySize > MAX_RESPONSE_BODY_BYTES) {
          logger.warn('Idempotency response body too large, skipping cache', {
            key: idempotencyKey,
            bodySize,
            limit: MAX_RESPONSE_BODY_BYTES,
          });
          // Clean up the pending record
          pool.query(
            `DELETE FROM idempotency_keys
             WHERE idempotency_key = $1 AND endpoint = $2 AND user_id = $3`,
            [idempotencyKey, endpoint, userId]
          ).catch((err) => {
            logger.warn('Failed to clean up oversized idempotency key', {
              err: err.message,
              key: idempotencyKey,
            });
          });
          return originalJson(body);
        }

        // Store response - pass body directly (pg driver serializes to JSONB)
        pool.query(
          `UPDATE idempotency_keys
           SET response_status = $1, response_body = $2
           WHERE idempotency_key = $3 AND endpoint = $4 AND user_id = $5`,
          [res.statusCode, body, idempotencyKey, endpoint, userId]
        ).catch((err) => {
          logger.warn('Failed to update idempotency key response', {
            err: err.message,
            key: idempotencyKey,
          });
        });

        return originalJson(body);
      };

      // Fallback: capture responses that bypass res.json (204, res.send, res.end)
      res.on('finish', () => {
        if (_captured) return; // Already handled by res.json wrapper

        if (!res.locals._idempotencyClaimed) return; // Row already cleaned up

        // Finalize the pending row with the actual status code and null body
        pool.query(
          `UPDATE idempotency_keys
           SET response_status = $1, response_body = NULL
           WHERE idempotency_key = $2 AND endpoint = $3 AND user_id = $4
           AND response_status = 0`,
          [res.statusCode, idempotencyKey, endpoint, userId]
        ).catch((err) => {
          logger.warn('Failed to finalize idempotency key via finish handler', {
            err: err.message,
            key: idempotencyKey,
          });
        });
      });

      // Wedge protection: clean up if connection is aborted
      res.on('close', () => {
        if (_captured) return;
        if (!res.writableFinished) {
          // Connection aborted before response completed - delete pending row
          res.locals._idempotencyClaimed = false;
          pool.query(
            `DELETE FROM idempotency_keys
             WHERE idempotency_key = $1 AND endpoint = $2 AND user_id = $3
             AND response_status = 0`,
            [idempotencyKey, endpoint, userId]
          ).catch((err) => {
            logger.warn('Failed to clean up idempotency key on close', {
              err: err.message,
              key: idempotencyKey,
            });
          });
        }
      });

      // Call next with wedge protection for synchronous errors
      try {
        next();
      } catch (err) {
        // Synchronous error in handler - clean up pending row
        res.locals._idempotencyClaimed = false;
        pool.query(
          `DELETE FROM idempotency_keys
           WHERE idempotency_key = $1 AND endpoint = $2 AND user_id = $3
           AND response_status = 0`,
          [idempotencyKey, endpoint, userId]
        ).catch((cleanupErr) => {
          logger.warn('Failed to clean up idempotency key on handler error', {
            err: (cleanupErr as Error).message,
            key: idempotencyKey,
          });
        });
        throw err;
      }
    } catch (err) {
      // DB error during claim - pass through without idempotency protection
      if (!res.headersSent) {
        logger.warn('Idempotency check failed', { error: (err as Error).message });
        next();
      }
    }
  };
}
