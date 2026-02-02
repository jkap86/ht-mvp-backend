import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

// Extend Express Request type to include requestId
declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

/**
 * Request ID middleware for distributed tracing
 * - Accepts X-Request-ID from client (for frontend correlation)
 * - Generates new UUID if not provided
 * - Attaches requestId to req object for logging
 * - Returns requestId in response header
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Use client-provided request ID or generate new one
  const requestId = (req.headers['x-request-id'] as string) || randomUUID();

  // Attach to request for use in controllers/services
  req.requestId = requestId;

  // Send back in response header for client-side correlation
  res.setHeader('X-Request-ID', requestId);

  next();
}
