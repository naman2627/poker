import type Redis from 'ioredis';
import type { KeyValueStore, RateLimitResult } from './ports';

/**
 * Redis behind the KeyValueStore port.
 *
 * `increment` is a single round trip that also sets the TTL on first sight, so
 * two requests racing on the same key cannot both think they were first and
 * leave a counter that never expires.
 */
export function createRedisStore(redis: Redis): KeyValueStore {
  return {
    async get(key: string): Promise<string | null> {
      return redis.get(key);
    },

    async set(key: string, value: string, ttlSeconds: number): Promise<void> {
      await redis.set(key, value, 'EX', ttlSeconds);
    },

    async delete(key: string): Promise<void> {
      await redis.del(key);
    },

    async increment(key: string, ttlSeconds: number): Promise<RateLimitResult> {
      const [count, ttl] = (await redis
        .multi()
        .incr(key)
        .expire(key, ttlSeconds, 'NX')
        .ttl(key)
        .exec()
        .then((replies) => [replies?.[0]?.[1], replies?.[2]?.[1]])) as [unknown, unknown];

      return {
        count: typeof count === 'number' ? count : 1,
        resetInSec: typeof ttl === 'number' && ttl > 0 ? ttl : ttlSeconds,
      };
    },
  };
}
