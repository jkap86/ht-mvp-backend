import { Socket } from 'socket.io';
import { logger } from '../config/env.config';

/**
 * Simple in-memory rate limiter for Socket.IO connections
 * Prevents DoS attacks from connection spam
 *
 * Configuration:
 * - Window: 60 seconds
 * - Max connections per IP: 10 per window
 * - Max connections per user: 5 concurrent connections
 */

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

// In-memory store for rate limiting
// In production with multiple instances, use Redis instead
const connectionAttempts = new Map<string, RateLimitEntry>();

// Cleanup old entries every 5 minutes
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

/**
 * Rate limit middleware for Socket.IO connections
 * Limits connections per IP address to prevent DoS attacks
 */
export function socketRateLimitMiddleware(socket: Socket, next: (err?: Error) => void): void {
  const ip = socket.handshake.address;
  const now = Date.now();

  // Get or create rate limit entry for this IP
  let entry = connectionAttempts.get(ip);

  if (!entry || now > entry.resetTime) {
    // Create new entry with fresh window
    entry = {
      count: 1,
      resetTime: now + WINDOW_MS,
    };
    connectionAttempts.set(ip, entry);
    return next();
  }

  // Increment connection count
  entry.count++;

  // Check if limit exceeded
  if (entry.count > MAX_CONNECTIONS_PER_IP) {
    const remainingTime = Math.ceil((entry.resetTime - now) / 1000);
    logger.warn('Socket connection rate limit exceeded', {
      ip,
      attempts: entry.count,
      remainingSeconds: remainingTime,
    });
    return next(new Error(`Too many connection attempts. Please try again in ${remainingTime} seconds.`));
  }

  // Allow connection
  next();
}

/**
 * Track concurrent connections per user to prevent resource exhaustion
 * This is separate from IP rate limiting and enforces per-user limits
 */
const userConnections = new Map<string, Set<string>>();
const MAX_CONCURRENT_CONNECTIONS_PER_USER = 5;

export function trackUserConnections(
  socket: Socket & { userId?: string },
  onConnectionLimit?: () => void
): void {
  if (!socket.userId) return;

  const userId = socket.userId;

  // Get or create connection set for this user
  if (!userConnections.has(userId)) {
    userConnections.set(userId, new Set());
  }

  const connections = userConnections.get(userId)!;

  // Check concurrent connection limit
  if (connections.size >= MAX_CONCURRENT_CONNECTIONS_PER_USER) {
    logger.warn('User concurrent connection limit reached', {
      userId,
      connections: connections.size,
      socketId: socket.id,
    });
    if (onConnectionLimit) {
      onConnectionLimit();
    }
    // Force disconnect the socket to enforce the limit
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
