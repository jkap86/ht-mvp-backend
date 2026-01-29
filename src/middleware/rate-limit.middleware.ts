import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { Request } from 'express';
import { getRedisClient } from '../config/redis.config';

// Match the shape from auth.middleware.ts
interface AuthRequest extends Request {
  user?: { userId: string; username: string };
}

function getRedisStore(): RedisStore | undefined {
  if (!process.env.REDIS_HOST) {
    return undefined; // Falls back to in-memory
  }
  return new RedisStore({
    sendCommand: (command: string, ...args: (string | number | Buffer)[]) =>
      getRedisClient().call(command, ...args) as Promise<any>,
  });
}

const isProd = process.env.NODE_ENV === 'production';

/**
 * Rate limiter for authentication endpoints (login, register)
 * Development: 100 attempts per 1 minute (relaxed for testing)
 * Production: 5 attempts per 15 minutes to prevent brute force attacks
 */
export const authLimiter = rateLimit({
  windowMs: isProd ? 15 * 60 * 1000 : 60 * 1000, // 15 min (prod) vs 1 min (dev)
  max: isProd ? 5 : 100, // 5 (prod) vs 100 (dev)
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many login attempts. Please try again later.',
    },
  },
  keyGenerator: (req: Request) => req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  store: getRedisStore(),
});

/**
 * Rate limiter for draft pick operations
 * Limits to 10 picks per minute per user
 */
export const draftPickLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: { error: 'Too many pick attempts, please slow down', status: 429 },
  keyGenerator: (req: AuthRequest) => req.user?.userId || req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  store: getRedisStore(),
});

/**
 * Rate limiter for queue operations (add, reorder, remove)
 * Limits to 30 operations per minute per user
 */
export const queueLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  message: {
    error: 'Too many queue operations, please slow down',
    status: 429,
  },
  keyGenerator: (req: AuthRequest) => req.user?.userId || req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  store: getRedisStore(),
});

/**
 * Rate limiter for draft creation/modification
 * Limits to 5 operations per minute per user
 */
export const draftModifyLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  message: {
    error: 'Too many draft operations, please slow down',
    status: 429,
  },
  keyGenerator: (req: AuthRequest) => req.user?.userId || req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  store: getRedisStore(),
});

/**
 * Rate limiter for refresh token endpoint
 * Limits to 30 attempts per hour per IP to prevent brute force attacks
 * More lenient than login since refresh is automated
 */
export const refreshTokenLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30, // 30 refresh attempts per hour
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many token refresh attempts. Please try again later.',
    },
  },
  keyGenerator: (req: Request) => req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  store: getRedisStore(),
});
