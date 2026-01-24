import { Request, Response, NextFunction } from 'express';

export function requestTimingMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const path = req.route?.path || req.path;
    const method = req.method;
    const status = res.statusCode;

    // Log slow requests (over 500ms)
    if (duration > 500) {
      console.warn(`Slow request: ${method} ${path} ${status} ${duration}ms`);
    }
  });

  next();
}
