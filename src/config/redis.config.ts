import Redis from 'ioredis';
import { env } from './env.config';
import { logger } from './logger.config';

const getRedisHost = (): string => {
  const host = process.env.REDIS_HOST;
  if (!host && env.NODE_ENV === 'production') {
    logger.warn('REDIS_HOST not configured in production - Redis features will be disabled');
  }
  return host || 'localhost';
};

export const redisConfig = {
  host: getRedisHost(),
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB || '0', 10),
  retryDelayOnFailover: 100,
  maxRetriesPerRequest: 3,
};

let redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis(redisConfig);
    redisClient.on('error', (err) => logger.error('Redis error', { error: err.message }));
    redisClient.on('connect', () => logger.info('Redis connected'));
  }
  return redisClient;
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

export async function checkRedisHealth(): Promise<boolean> {
  try {
    const redis = getRedisClient();
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

/**
 * Check if Redis is configured and available.
 * This is a synchronous check based on configuration, not connectivity.
 */
export function isRedisAvailable(): boolean {
  return !!process.env.REDIS_HOST;
}
