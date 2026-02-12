import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Wraps an async route handler to automatically catch rejected promises
 * and forward them to Express error-handling middleware via next(error).
 *
 * Usage in route files:
 *   router.get('/:id', asyncHandler(controller.getById));
 *
 * This eliminates the need for try-catch blocks in every controller method.
 */
export const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
): RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
