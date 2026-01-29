import { Request, Response, NextFunction } from 'express';
import { AppException } from '../utils/exceptions';
import { metrics } from '../services/metrics.service';
import { logger } from '../config/logger.config';
import { env } from '../config/env.config';

export const errorHandler = (
  err: Error | AppException,
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  metrics.increment('errors_total');

  // Handle custom AppException instances
  if (err instanceof AppException) {
    logger.warn('Application error', {
      code: err.errorCode,
      message: err.message,
      statusCode: err.statusCode,
      path: req.path,
      method: req.method,
    });

    return res.status(err.statusCode).json({
      error: {
        code: err.errorCode,
        message: err.message,
      },
    });
  }

  // Handle unexpected errors
  // SECURITY: Only log full stack traces in development to prevent
  // information leakage through log aggregation services
  const logPayload: Record<string, unknown> = {
    error: err.message,
    path: req.path,
    method: req.method,
  };

  if (env.NODE_ENV !== 'production') {
    logPayload.stack = err.stack;
  } else {
    // In production, log only the first line of stack (error type + location)
    logPayload.errorType = err.constructor.name;
  }

  logger.error('Unexpected error', logPayload);

  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  });
};
