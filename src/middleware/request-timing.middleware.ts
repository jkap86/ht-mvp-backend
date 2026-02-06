import { Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger.config';

export function requestTimingMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const path = req.route?.path || req.path;
    const method = req.method;
    const status = res.statusCode;

    // Log slow requests (over 500ms)
    if (duration > 500) {
      logger.warn('Slow request detected', { method, path, status, durationMs: duration });
    }
  });

  next();
}
