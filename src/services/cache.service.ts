import { getRedisClient } from '../config/redis.config';
import { logger } from '../config/logger.config';

export class CacheService {
  private prefix = 'ht:';

  async get<T>(key: string): Promise<T | null> {
    try {
      const redis = getRedisClient();
      const data = await redis.get(this.prefix + key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      logger.warn('Cache get failed', { key, error });
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds = 300): Promise<void> {
    try {
      const redis = getRedisClient();
      await redis.setex(this.prefix + key, ttlSeconds, JSON.stringify(value));
    } catch (error) {
      logger.warn('Cache set failed', { key, error });
    }
  }

  async del(key: string): Promise<void> {
    try {
      const redis = getRedisClient();
      await redis.del(this.prefix + key);
    } catch (error) {
      logger.warn('Cache del failed', { key, error });
    }
  }

  async delPattern(pattern: string): Promise<void> {
    try {
      const redis = getRedisClient();
      // Use SCAN instead of KEYS to avoid blocking Redis on large keyspaces
      let cursor = '0';
      const allKeys: string[] = [];
      do {
        const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', this.prefix + pattern, 'COUNT', 100);
        cursor = nextCursor;
        allKeys.push(...batch);
      } while (cursor !== '0');

      if (allKeys.length > 0) {
        await redis.del(...allKeys);
      }
    } catch (error) {
      logger.warn('Cache delPattern failed', { pattern, error });
    }
  }
}
