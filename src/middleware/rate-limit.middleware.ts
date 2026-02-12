import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { Request } from 'express';
import { getRedisClient } from '../config/redis.config';
import { logger } from '../config/logger.config';

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

if (isProd && !process.env.REDIS_HOST) {
  throw new Error(
    'REDIS_HOST is required in production. ' +
      'Rate limiting with in-memory stores is unsafe for multi-instance deployments ' +
      'because limits are not shared across instances. ' +
      'Set REDIS_HOST to enable Redis-backed rate limiting.'
  );
}

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
  message: {
    error: { code: 'RATE_LIMITED', message: 'Too many pick attempts, please slow down' },
  },
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
    error: { code: 'RATE_LIMITED', message: 'Too many queue operations, please slow down' },
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
    error: { code: 'RATE_LIMITED', message: 'Too many draft operations, please slow down' },
  },
  keyGenerator: (req: AuthRequest) => req.user?.userId || req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  store: getRedisStore(),
});

/**
 * Rate limiter for direct message sending
 * Limits to 30 messages per minute per user to prevent spam
 */
export const dmMessageLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 messages per minute
  message: {
    error: { code: 'RATE_LIMITED', message: 'Too many messages, please slow down' },
  },
  keyGenerator: (req: AuthRequest) => req.user?.userId || req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  store: getRedisStore(),
});

/**
 * Rate limiter for DM read operations (fetching conversations/messages)
 * More lenient than message sending - 60 requests per minute
 */
export const dmReadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute
  message: {
    error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down' },
  },
  keyGenerator: (req: AuthRequest) => req.user?.userId || req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  store: getRedisStore(),
});

/**
 * Rate limiter for user search operations
 * Limits to 30 searches per minute per user to prevent enumeration attacks
 */
export const searchLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 searches per minute
  message: {
    error: { code: 'RATE_LIMITED', message: 'Too many search requests, please slow down' },
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

/**
 * Rate limiter for general API read operations
 * Limits to 120 requests per minute per user
 * Used for league, roster, matchup, draft, and other read endpoints
 */
export const apiReadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // 120 requests per minute
  message: {
    error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down' },
  },
  keyGenerator: (req: AuthRequest) => req.user?.userId || req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  store: getRedisStore(),
});

/**
 * Rate limiter for general write operations (create, update, delete)
 * Limits to 60 requests per minute per user
 * Used for notification preferences, device registration, and other write endpoints
 */
export const apiWriteLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 write operations per minute
  message: {
    error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down' },
  },
  keyGenerator: (req: AuthRequest) => req.user?.userId || req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  store: getRedisStore(),
});

/**
 * Rate limiter for trade operations (propose, accept, reject, counter)
 * Limits to 20 operations per minute per user
 */
export const tradeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 trade operations per minute
  message: {
    error: { code: 'RATE_LIMITED', message: 'Too many trade operations, please slow down' },
  },
  keyGenerator: (req: AuthRequest) => req.user?.userId || req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  store: getRedisStore(),
});

/**
 * Rate limiter for roster modification operations (add/drop players, lineup changes)
 * Limits to 30 operations per minute per user
 */
export const rosterModifyLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 roster operations per minute
  message: {
    error: { code: 'RATE_LIMITED', message: 'Too many roster operations, please slow down' },
  },
  keyGenerator: (req: AuthRequest) => req.user?.userId || req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  store: getRedisStore(),
});

/**
 * Rate limiter for waiver operations (submit/cancel claims)
 * Limits to 20 operations per minute per user
 */
export const waiverLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 waiver operations per minute
  message: {
    error: { code: 'RATE_LIMITED', message: 'Too many waiver operations, please slow down' },
  },
  keyGenerator: (req: AuthRequest) => req.user?.userId || req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  store: getRedisStore(),
});

/**
 * Rate limiter for expensive player sync operations
 * Limits to 2 operations per hour per user (these are expensive API calls)
 */
export const playerSyncLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 2, // 2 syncs per hour
  message: {
    error: { code: 'RATE_LIMITED', message: 'Player sync is rate limited. Please try again later.' },
  },
  keyGenerator: (req: AuthRequest) => req.user?.userId || req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  store: getRedisStore(),
});
