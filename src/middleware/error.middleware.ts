import { Request, Response, NextFunction } from 'express';
import { AppException } from '../utils/exceptions';
import { metrics } from '../services/metrics.service';
import { logger } from '../config/logger.config';
import { env } from '../config/env.config';

/**
 * Checks if an error is a PostgreSQL database error
 * These errors can contain sensitive schema information
 */
function isDatabaseError(err: Error): boolean {
  const message = err.message?.toLowerCase() || '';
  const name = err.name?.toLowerCase() || '';

  // Check for PostgreSQL error patterns
  const dbPatterns = [
    'relation', 'column', 'table', 'schema', 'constraint',
    'foreign key', 'unique violation', 'duplicate key',
    'syntax error', 'permission denied', 'does not exist',
    'violates', 'null value', 'data type',
  ];

  // Check for pg/node-postgres error names
  const dbErrorNames = ['databaseerror', 'queryerror', 'parseerror'];

  if (dbErrorNames.some((n) => name.includes(n))) {
    return true;
  }

  return dbPatterns.some((pattern) => message.includes(pattern));
}

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

  // Detect database errors and use appropriate error code
  const isDbError = isDatabaseError(err);
  if (isDbError) {
    metrics.increment('database_errors_total');
    logger.error('Database error', logPayload);
  } else {
    logger.error('Unexpected error', logPayload);
  }

  // SECURITY: Always return a generic message to prevent schema leakage
  return res.status(500).json({
    error: {
      code: isDbError ? 'DATABASE_ERROR' : 'INTERNAL_ERROR',
      message: 'An error occurred while processing your request',
    },
  });
};
