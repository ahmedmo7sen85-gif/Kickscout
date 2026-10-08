import { sql } from 'kysely';
import type { Database } from '@fp/db';
import type { FastifyRateLimitStoreCtor } from '@fastify/rate-limit';

type IncrCallback = (error: Error | null, result?: { current: number; ttl: number }) => void;

/**
 * @fastify/rate-limit store backed by Postgres, so a limit holds across every API instance
 * (serverless functions keep no shared memory). One row per key; a window that has ended restarts at 1.
 * Each route-specific limit gets its own key prefix through `child`.
 */
export function postgresRateStore(db: Database): FastifyRateLimitStoreCtor {
  // The plugin's typings omit the `timeWindow` argument it passes to `incr` at runtime, hence the cast below.
  class PostgresRateStore {
    // The plugin constructs the store with its options object; only `child` passes a prefix.
    private readonly prefix: string;
    constructor(_options?: unknown, prefix = 'g') {
      this.prefix = prefix;
    }

    incr(key: string, cb: IncrCallback, timeWindow: number, _max?: number) {
      const k = `${this.prefix}:${key}`;
      const windowSecs = timeWindow / 1000;
      sql<{ count: number; ttl_ms: number }>`
        INSERT INTO rate_limit_hits (key, count, reset_at)
        VALUES (${k}, 1, now() + make_interval(secs => ${windowSecs}))
        ON CONFLICT (key) DO UPDATE SET
          count = CASE WHEN rate_limit_hits.reset_at <= now() THEN 1 ELSE rate_limit_hits.count + 1 END,
          reset_at = CASE WHEN rate_limit_hits.reset_at <= now() THEN now() + make_interval(secs => ${windowSecs}) ELSE rate_limit_hits.reset_at END
        RETURNING count, (extract(epoch FROM reset_at - now()) * 1000)::int AS ttl_ms`
        .execute(db)
        .then(({ rows }) => cb(null, { current: rows[0]!.count, ttl: Math.max(0, rows[0]!.ttl_ms) }))
        .catch((err: Error) => cb(err));
    }

    child(routeOptions: { method?: string | string[]; url?: string; path?: string }) {
      const method = Array.isArray(routeOptions.method) ? routeOptions.method.join(',') : (routeOptions.method ?? '');
      return new PostgresRateStore(undefined, `${method} ${routeOptions.url ?? routeOptions.path ?? ''}`);
    }
  }
  return PostgresRateStore as unknown as FastifyRateLimitStoreCtor;
}

