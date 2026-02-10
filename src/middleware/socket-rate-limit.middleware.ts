import { Socket } from 'socket.io';
import { logger } from '../config/logger.config';
import { getRedisClient } from '../config/redis.config';

if (process.env.NODE_ENV === 'production' && !process.env.REDIS_HOST) {
  logger.warn(
    'CRITICAL: Socket rate limiting is using in-memory store in production. ' +
      'This is unsafe for multi-instance deployments as limits are not shared across instances. ' +
      'Set REDIS_HOST to enable Redis-backed rate limiting.'
  );
}

/**
 * Rate limiter for Socket.IO connections
 * Prevents DoS attacks from connection spam
 *
 * Configuration:
 * - Window: 60 seconds
 * - Max connections per IP: 10 per window
 * - Max connections per user: 5 concurrent connections
 *
 * Uses Redis when available for multi-instance support, falls back to in-memory.
 */

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

// In-memory fallback store for rate limiting (used when Redis unavailable)
const connectionAttempts = new Map<string, RateLimitEntry>();

// Cleanup old entries every 5 minutes (in-memory fallback only)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of connectionAttempts.entries()) {
    if (now > entry.resetTime) {
      connectionAttempts.delete(key);
    }
  }
}, 5 * 60 * 1000);

const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_CONNECTIONS_PER_IP = 10;
const REDIS_KEY_PREFIX = 'socket_ratelimit:';

/**
 * Check if Redis is available for rate limiting
 */
function isRedisAvailable(): boolean {
  return !!process.env.REDIS_HOST;
}

/**
 * Redis-based rate limiting for socket connections
 */
async function checkRateLimitRedis(ip: string): Promise<{ allowed: boolean; remainingTime?: number }> {
  const redis = getRedisClient();
  const key = `${REDIS_KEY_PREFIX}${ip}`;

  try {
    // Use Redis INCR with EXPIRE for atomic rate limiting
    const count = await redis.incr(key);

    // Set expiry only on first increment
    if (count === 1) {
      await redis.expire(key, Math.ceil(WINDOW_MS / 1000));
    }

    if (count > MAX_CONNECTIONS_PER_IP) {
      const ttl = await redis.ttl(key);
      return { allowed: false, remainingTime: ttl > 0 ? ttl : Math.ceil(WINDOW_MS / 1000) };
    }

    return { allowed: true };
  } catch (error) {
    logger.error('Redis rate limit error, falling back to in-memory', { error });
    // Fall back to in-memory on Redis error
    return checkRateLimitInMemory(ip);
  }
}

/**
 * In-memory rate limiting fallback
 */
function checkRateLimitInMemory(ip: string): { allowed: boolean; remainingTime?: number } {
  const now = Date.now();
  let entry = connectionAttempts.get(ip);

  if (!entry || now > entry.resetTime) {
    entry = {
      count: 1,
      resetTime: now + WINDOW_MS,
    };
    connectionAttempts.set(ip, entry);
    return { allowed: true };
  }

  entry.count++;

  if (entry.count > MAX_CONNECTIONS_PER_IP) {
    const remainingTime = Math.ceil((entry.resetTime - now) / 1000);
    return { allowed: false, remainingTime };
  }

  return { allowed: true };
}

/**
 * Rate limit middleware for Socket.IO connections
 * Limits connections per IP address to prevent DoS attacks
 * Uses Redis when available for multi-instance support
 */
export function socketRateLimitMiddleware(socket: Socket, next: (err?: Error) => void): void {
  const ip = socket.handshake.address;

  if (isRedisAvailable()) {
    // Use Redis-based rate limiting
    checkRateLimitRedis(ip)
      .then(({ allowed, remainingTime }) => {
        if (!allowed) {
          logger.warn('Socket connection rate limit exceeded (Redis)', {
            ip,
            remainingSeconds: remainingTime,
          });
          return next(new Error(`Too many connection attempts. Please try again in ${remainingTime} seconds.`));
        }
        next();
      })
      .catch((error) => {
        logger.error('Socket rate limit check failed', { error });
        // Allow connection on error to prevent blocking all connections
        next();
      });
  } else {
    // Use in-memory rate limiting
    const { allowed, remainingTime } = checkRateLimitInMemory(ip);

    if (!allowed) {
      logger.warn('Socket connection rate limit exceeded (in-memory)', {
        ip,
        remainingSeconds: remainingTime,
      });
      return next(new Error(`Too many connection attempts. Please try again in ${remainingTime} seconds.`));
    }

    next();
  }
}

/**
 * Track concurrent connections per user to prevent resource exhaustion
 * This is separate from IP rate limiting and enforces per-user limits
 * Uses Redis when available for multi-instance support
 */
const userConnections = new Map<string, Set<string>>();
const MAX_CONCURRENT_CONNECTIONS_PER_USER = 5;
const USER_CONNECTIONS_PREFIX = 'socket_user_conns:';

export function trackUserConnections(
  socket: Socket & { userId?: string },
  onConnectionLimit?: () => void
): void {
  if (!socket.userId) return;

  const userId = socket.userId;

  if (isRedisAvailable()) {
    // Use Redis for tracking (async, fire-and-forget for add)
    trackUserConnectionsRedis(socket, userId, onConnectionLimit);
  } else {
    // Use in-memory tracking
    trackUserConnectionsInMemory(socket, userId, onConnectionLimit);
  }
}

async function trackUserConnectionsRedis(
  socket: Socket & { userId?: string },
  userId: string,
  onConnectionLimit?: () => void
): Promise<void> {
  const redis = getRedisClient();
  const key = `${USER_CONNECTIONS_PREFIX}${userId}`;

  try {
    // Get current connection count
    const count = await redis.scard(key);

    if (count >= MAX_CONCURRENT_CONNECTIONS_PER_USER) {
      logger.warn('User concurrent connection limit reached (Redis)', {
        userId,
        connections: count,
        socketId: socket.id,
      });
      if (onConnectionLimit) {
        onConnectionLimit();
      }
      socket.disconnect(true);
      return;
    }

    // Add this connection
    await redis.sadd(key, socket.id);
    // Set expiry to clean up stale entries (24 hours)
    await redis.expire(key, 86400);

    // Clean up on disconnect
    socket.on('disconnect', async () => {
      try {
        await redis.srem(key, socket.id);
      } catch (error) {
        logger.error('Failed to remove socket from Redis', { error, userId, socketId: socket.id });
      }
    });
  } catch (error) {
    logger.error('Redis user connection tracking error, falling back to in-memory', { error });
    // Fall back to in-memory
    trackUserConnectionsInMemory(socket, userId, onConnectionLimit);
  }
}

function trackUserConnectionsInMemory(
  socket: Socket & { userId?: string },
  userId: string,
  onConnectionLimit?: () => void
): void {
  // Get or create connection set for this user
  if (!userConnections.has(userId)) {
    userConnections.set(userId, new Set());
  }

  const connections = userConnections.get(userId)!;

  // Check concurrent connection limit
  if (connections.size >= MAX_CONCURRENT_CONNECTIONS_PER_USER) {
    logger.warn('User concurrent connection limit reached (in-memory)', {
      userId,
      connections: connections.size,
      socketId: socket.id,
    });
    if (onConnectionLimit) {
      onConnectionLimit();
    }
    socket.disconnect(true);
    return;
  }

  // Add this connection
  connections.add(socket.id);

  // Clean up on disconnect
  socket.on('disconnect', () => {
    connections.delete(socket.id);
    if (connections.size === 0) {
      userConnections.delete(userId);
    }
  });
}
