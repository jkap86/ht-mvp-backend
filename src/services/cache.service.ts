import { getRedisClient } from '../config/redis.config';

export class CacheService {
  private prefix = 'ht:';

  async get<T>(key: string): Promise<T | null> {
    const redis = getRedisClient();
    const data = await redis.get(this.prefix + key);
    return data ? JSON.parse(data) : null;
  }

  async set(key: string, value: unknown, ttlSeconds = 300): Promise<void> {
    const redis = getRedisClient();
    await redis.setex(this.prefix + key, ttlSeconds, JSON.stringify(value));
  }

  async del(key: string): Promise<void> {
    const redis = getRedisClient();
    await redis.del(this.prefix + key);
  }

  async delPattern(pattern: string): Promise<void> {
    const redis = getRedisClient();
    const keys = await redis.keys(this.prefix + pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }
}
