import rateLimit from 'express-rate-limit';
import { Request } from 'express';

interface AuthRequest extends Request {
  user?: { id: string };
}

/**
 * Rate limiter for draft pick operations
 * Limits to 10 picks per minute per user
 */
export const draftPickLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: { error: 'Too many pick attempts, please slow down', status: 429 },
  keyGenerator: (req: AuthRequest) => req.user?.id || req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Rate limiter for queue operations (add, reorder, remove)
 * Limits to 30 operations per minute per user
 */
export const queueLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  message: { error: 'Too many queue operations, please slow down', status: 429 },
  keyGenerator: (req: AuthRequest) => req.user?.id || req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Rate limiter for draft creation/modification
 * Limits to 5 operations per minute per user
 */
export const draftModifyLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  message: { error: 'Too many draft operations, please slow down', status: 429 },
  keyGenerator: (req: AuthRequest) => req.user?.id || req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
});
