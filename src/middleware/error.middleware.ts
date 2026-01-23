import { Request, Response, NextFunction } from 'express';
import { AppException } from '../utils/exceptions';

export const errorHandler = (
  err: Error | AppException,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Handle custom AppException instances
  if (err instanceof AppException) {
    return res.status(err.statusCode).json({
      error: {
        code: err.errorCode,
        message: err.message,
      },
    });
  }

  // Handle unexpected errors
  console.error('Unexpected error:', err);

  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  });
};
