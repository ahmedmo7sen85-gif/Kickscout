import type { FastifyBaseLogger } from 'fastify';

export interface ErrorContext {
  requestId: string;
  method: string;
  /** The route pattern (e.g. /v1/videos/:videoId), never the raw URL with ids or query strings. */
  route: string;
  /** Keyed hash of the caller's user id, when signed in. */
  userHash: string | null;
}

/**
 * Where unexpected (5xx) errors go. The default writes one structured log line; a hosted error
 * tracker can be plugged in later by implementing this interface and passing it in Deps.
 */
export interface ErrorReporter {
  capture(err: unknown, context: ErrorContext, log: FastifyBaseLogger): void;
}

export class LogErrorReporter implements ErrorReporter {
  capture(err: unknown, context: ErrorContext, log: FastifyBaseLogger) {
    const e = err instanceof Error ? err : new Error(String(err));
    log.error({ err: e, errorName: e.name, ...context }, 'unhandled error');
  }
}
