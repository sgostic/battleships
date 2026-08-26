/**
 * Shared state for online matches.
 *
 * Production uses Upstash Redis (Vercel Marketplace), which is the only way two
 * serverless invocations can see the same room. Local `next dev` falls back to a
 * process-local map so the game is playable before the integration is provisioned;
 * that fallback is refused in production, where it would silently break matches
 * across function instances.
 */

import { Redis } from '@upstash/redis';

export type Store = {
  readonly kind: 'redis' | 'memory';
  getJSON<T>(key: string): Promise<T | null>;
  setJSON(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  /** SET key token NX PX ttl — returns false when someone else holds the lock. */
  acquire(key: string, token: string, ttlMs: number): Promise<boolean>;
  /** Releases only if we still own it, so a timed-out holder cannot free ours. */
  release(key: string, token: string): Promise<void>;
  rpush(key: string, value: string, ttlSeconds: number): Promise<void>;
  lpop(key: string): Promise<string | null>;
  lrem(key: string, value: string): Promise<void>;
};

function redisCredentials(): { url: string; token: string } | null {
  const url =
    process.env.UPSTASH_REDIS_REST_URL ??
    process.env.KV_REST_API_URL ??
    process.env.REDIS_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ??
    process.env.KV_REST_API_TOKEN ??
    process.env.REDIS_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

export function storeKind(): 'redis' | 'memory' | 'missing' {
  if (redisCredentials()) return 'redis';
  return process.env.NODE_ENV === 'production' ? 'missing' : 'memory';
}

function redisStore(url: string, token: string): Store {
  const redis = new Redis({ url, token });
  return {
    kind: 'redis',
    async getJSON<T>(key: string) {
      // The REST client already parses JSON responses.
      return (await redis.get<T>(key)) ?? null;
    },
    async setJSON(key, value, ttlSeconds) {
      await redis.set(key, JSON.stringify(value), { ex: ttlSeconds });
    },
    async del(key) {
      await redis.del(key);
    },
    async acquire(key, token, ttlMs) {
      const res = await redis.set(key, token, { nx: true, px: ttlMs });
      return res === 'OK';
    },
    async release(key, token) {
      await redis.eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
        [key],
        [token],
      );
    },
    async rpush(key, value, ttlSeconds) {
      await redis.rpush(key, value);
      await redis.expire(key, ttlSeconds);
    },
    async lpop(key) {
      const v = await redis.lpop<string>(key);
      return v ?? null;
    },
    async lrem(key, value) {
      await redis.lrem(key, 0, value);
    },
  };
}

type Entry = { value: string; expiresAt: number };

function memoryStore(): Store {
  const map = new Map<string, Entry>();
  const lists = new Map<string, { items: string[]; expiresAt: number }>();

  const live = (e: { expiresAt: number } | undefined): boolean =>
    Boolean(e && e.expiresAt > Date.now());

  return {
    kind: 'memory',
    async getJSON<T>(key: string) {
      const e = map.get(key);
      if (!live(e)) {
        map.delete(key);
        return null;
      }
      return JSON.parse(e!.value) as T;
    },
    async setJSON(key, value, ttlSeconds) {
      map.set(key, { value: JSON.stringify(value), expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async del(key) {
      map.delete(key);
    },
    async acquire(key, token, ttlMs) {
      const e = map.get(key);
      if (live(e)) return false;
      map.set(key, { value: token, expiresAt: Date.now() + ttlMs });
      return true;
    },
    async release(key, token) {
      const e = map.get(key);
      if (e && e.value === token) map.delete(key);
    },
    async rpush(key, value, ttlSeconds) {
      const existing = lists.get(key);
      const list = live(existing) ? existing! : { items: [], expiresAt: 0 };
      list.items.push(value);
      list.expiresAt = Date.now() + ttlSeconds * 1000;
      lists.set(key, list);
    },
    async lpop(key) {
      const list = lists.get(key);
      if (!live(list)) {
        lists.delete(key);
        return null;
      }
      return list!.items.shift() ?? null;
    },
    async lrem(key, value) {
      const list = lists.get(key);
      if (!live(list)) return;
      list!.items = list!.items.filter((v) => v !== value);
    },
  };
}

/**
 * Held on globalThis so `next dev` hot reloads keep in-flight matches, and so a
 * warm Fluid Compute instance reuses one Redis client across requests.
 */
const globalForStore = globalThis as typeof globalThis & { __seaBattleStore?: Store };

export function getStore(): Store {
  if (globalForStore.__seaBattleStore) return globalForStore.__seaBattleStore;

  const creds = redisCredentials();
  if (creds) {
    globalForStore.__seaBattleStore = redisStore(creds.url, creds.token);
  } else {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'No Redis credentials found. Online play needs the Upstash for Redis integration: ' +
          '`vercel integration add upstash/upstash-kv` then `vercel env pull`.',
      );
    }
    console.warn(
      '[sea-battle] No Upstash credentials — using an in-memory store. ' +
        'Fine for local dev, but matches will not survive a restart and will not work when deployed.',
    );
    globalForStore.__seaBattleStore = memoryStore();
  }
  return globalForStore.__seaBattleStore;
}
