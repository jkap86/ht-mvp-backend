import { Request, Response, NextFunction } from 'express';
import { AppException } from '../utils/exceptions';
import { metrics } from '../services/metrics.service';
import { logger } from '../config/logger.config';

export const errorHandler = (
  err: Error | AppException,
  req: Request,
  res: Response,
  next: NextFunction
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
  logger.error('Unexpected error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  });
};
