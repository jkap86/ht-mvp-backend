/**
 * Request Context Middleware
 *
 * Sets up query context for HTTP requests using AsyncLocalStorage.
 * All database queries within the request lifecycle will have access
 * to the request context for logging and tracing.
 */

import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { withQueryContext, createRequestContext } from '../shared/query-context';

/**
 * Extended request type with userId from auth middleware.
 */
interface AuthenticatedRequest extends Request {
  userId?: string;
}

/**
 * Middleware that establishes query context for the request.
 * Must be placed after authentication middleware to capture userId.
 *
 * This middleware:
 * 1. Generates or uses existing X-Request-ID header
 * 2. Sets X-Request-ID response header for client correlation
 * 3. Runs the rest of the request within a query context
 *
 * @example
 * ```typescript
 * // In app setup (after auth middleware)
 * app.use(requestContextMiddleware);
 * ```
 */
export function requestContextMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Get or generate request ID
  const requestId = (req.headers['x-request-id'] as string) || uuidv4();

  // Get user ID from authenticated request (may be undefined)
  const userId = (req as AuthenticatedRequest).userId;

  // Set response header for client-side correlation
  res.setHeader('x-request-id', requestId);

  // Create the context
  const context = createRequestContext(requestId, userId);

  // Run the rest of the request within the query context
  withQueryContext(context, () => {
    next();
  });
}
