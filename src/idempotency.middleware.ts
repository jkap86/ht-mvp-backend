import { Request, Response, NextFunction } from 'express';
import { container, KEYS } from './container';
import { Pool } from 'pg';
import { logger } from './config/logger.config';

/**
 * Middleware to handle idempotent requests via 'x-idempotency-key' header.
 * Prevents duplicate processing of mutating operations.
 */
export const idempotencyMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const idempotencyKey = req.headers['x-idempotency-key'] as string;

  // Skip if no key or not a mutating method
  if (!idempotencyKey || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return next();
  }

  const pool = container.resolve<Pool>(KEYS.POOL);
  // Note: req.user might not be populated yet if this runs before Auth middleware.
  // We rely on the high entropy of the UUID key for uniqueness if user is not available.
  const userId = (req as any).user?.id || null;

  try {
    // Check for existing key
    const result = await pool.query(
      'SELECT response_code, response_body FROM idempotency_keys WHERE key = $1',
      [idempotencyKey]
    );

    if (result.rows.length > 0) {
      const { response_code, response_body } = result.rows[0];

      if (response_code) {
        // Request already completed
        logger.info('Idempotency hit: returning cached response', { idempotencyKey });
        res.set('x-idempotency-hit', 'true');
        res.status(response_code).json(response_body);
        return;
      } else {
        // Request in progress
        logger.warn('Idempotency conflict: request in progress', { idempotencyKey });
        res.status(409).json({
          code: 'CONFLICT',
          message: 'Request with this idempotency key is currently being processed',
        });
        return;
      }
    }

    // Create record for new request
    await pool.query(
      `INSERT INTO idempotency_keys (key, user_id, created_at, expires_at)
       VALUES ($1, $2, NOW(), NOW() + INTERVAL '24 hours')`,
      [idempotencyKey, userId]
    );

    // Hook response.json to capture and save the result
    const originalJson = res.json;
    res.json = function (body: any): Response {
      const responseCode = res.statusCode;

      // Async update to save response (fire and forget to not block response)
      pool
        .query(
          'UPDATE idempotency_keys SET response_code = $1, response_body = $2 WHERE key = $3',
          [responseCode, body, idempotencyKey]
        )
        .catch((err) => {
          logger.error('Failed to update idempotency record', { error: err, idempotencyKey });
        });

      return originalJson.call(this, body);
    };

    next();
  } catch (error) {
    logger.error('Idempotency middleware error', { error });
    // Fail closed to prevent double processing if DB is unreachable
    next(error);
  }
};
