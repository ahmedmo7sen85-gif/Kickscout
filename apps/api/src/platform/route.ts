import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { Actor, Action } from '@fp/domain';
import { can } from '@fp/domain';
import type { RouteSpec } from '@fp/contracts';
import { ApiError } from './errors.js';
import { loadActor } from './actor.js';
import type { Identity } from './auth.js';
import type { Deps } from '../deps.js';

/**
 * Auth modes:
 * - none: public
 * - identity: a valid token, user may not be registered yet (registration only)
 * - user: a registered user; `actor` is loaded from the database
 * - optional: like user when a token is present, anonymous otherwise
 */
export type AuthMode = 'none' | 'identity' | 'user' | 'optional';

type Out<T> = T extends z.ZodType ? z.output<T> : undefined;
type In<T> = T extends z.ZodType ? z.input<T> : void;

export interface Ctx<Q, B> {
  req: FastifyRequest;
  deps: Deps;
  params: Record<string, string>;
  query: Q;
  body: B;
  identity: Identity | null;
  actor: Actor | null;
  /** The registered actor; throws 401 when absent. */
  me(): Actor;
  /** Runs the policy and throws 403 with the policy's code when denied. */
  authorize(action: Action): void;
}

export interface RateLimit {
  max: number;
  timeWindow: string;
}

export interface ApiRoute extends Omit<RouteSpec, 'auth'> {
  auth: AuthMode;
  /** Stricter per-route limit on top of the global one (uploads, comments, reports, contact). */
  rateLimit?: RateLimit;
  /** The handler reads the exact request bytes as a Buffer (`ctx.req.body`), e.g. to check a webhook signature. */
  rawBody?: boolean;
  handler: (ctx: Ctx<any, any>) => Promise<unknown>;
}

export function route<QS extends z.ZodObject | undefined, BS extends z.ZodType | undefined, RS extends z.ZodType | undefined>(
  spec: Omit<RouteSpec, 'auth' | 'query' | 'body' | 'response'> & { auth: AuthMode; query?: QS; body?: BS; response?: RS; rateLimit?: RateLimit; rawBody?: boolean },
  handler: (ctx: Ctx<Out<QS>, Out<BS>>) => Promise<In<RS>>,
): ApiRoute {
  return { ...spec, handler } as ApiRoute;
}

export function toRouteSpec(r: ApiRoute): RouteSpec {
  const { handler: _h, auth, rateLimit: _r, rawBody: _b, ...rest } = r;
  return { ...rest, auth: auth !== 'none' };
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const [scheme, token] = h.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

export function register(app: FastifyInstance, deps: Deps, routes: readonly ApiRoute[]) {
  for (const r of routes) {
    app.route({
      method: r.method.toUpperCase() as 'GET',
      url: r.path,
      ...(r.rateLimit ? { config: { rateLimit: r.rateLimit } } : {}),
      handler: async (req, reply) => {
        let identity: Identity | null = null;
        let actor: Actor | null = null;

        if (r.auth !== 'none') {
          const token = bearer(req);
          if (token) {
            try {
              identity = await deps.verifier.verify(token);
            } catch {
              throw new ApiError(401, 'INVALID_TOKEN', 'access token is invalid or expired');
            }
            actor = await loadActor(deps.db, identity);
          } else if (r.auth !== 'optional') {
            throw new ApiError(401, 'UNAUTHENTICATED', 'sign in required');
          }
          if (r.auth === 'user' && !actor) throw new ApiError(403, 'NOT_REGISTERED', 'complete registration first');
        }

        const ctx: Ctx<unknown, unknown> = {
          req,
          deps,
          params: req.params as Record<string, string>,
          query: r.query ? r.query.parse(req.query ?? {}) : undefined,
          body: r.body ? r.body.parse(req.body ?? {}) : undefined,
          identity,
          actor,
          me() {
            if (!actor) throw new ApiError(401, 'UNAUTHENTICATED', 'sign in required');
            return actor;
          },
          authorize(action) {
            const decision = can(this.me(), action);
            if (!decision.allowed) throw new ApiError(403, decision.code, decision.reason);
          },
        };

        const result = await r.handler(ctx);
        reply.status(r.status ?? 200);
        if (r.response === undefined) return reply.send();
        // Responses are validated too, so the contract cannot silently drift.
        return reply.send(r.response.parse(result));
      },
    });
  }
}
