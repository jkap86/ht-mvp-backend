import { Request, Response, NextFunction } from 'express';
import { getPoolHealth, PoolHealth } from '../db/pool';
import { logger } from '../config/logger.config';

/**
 * Circuit breaker middleware that rejects incoming requests when the
 * database connection pool is in a CRITICAL state.
 *
 * This is a lightweight check (no DB queries) that reads pool counters
 * to prevent cascading failures when the pool is near exhaustion.
 */
export function poolHealthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const health = getPoolHealth();

  if (health === PoolHealth.CRITICAL) {
    logger.warn('Pool circuit breaker: rejecting request', {
      path: req.path,
      method: req.method,
    });
    res.status(503).json({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Server is under heavy load. Please try again shortly.',
      },
    });
    return;
  }

  next();
}
