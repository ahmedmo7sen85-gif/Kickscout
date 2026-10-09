import Fastify, { LogController } from 'fastify';
import type { FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cors from '@fastify/cors';
import { createHash, randomUUID } from 'node:crypto';
import { buildOpenApi } from '@fp/contracts';
import type { Deps } from './deps.js';
import { problemHandler } from './platform/errors.js';
import { register, toRouteSpec } from './platform/route.js';
import { postgresRateStore } from './platform/rate-store.js';
import { LogErrorReporter } from './platform/error-reporter.js';
import { userHash } from './platform/analytics.js';
import { routes } from './routes.js';
import { API_VERSION } from './platform/version.js';

export { API_VERSION };
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function openApiDocument() {
  return buildOpenApi(routes.map(toRouteSpec), { title: 'KICKSCOUT API', version: API_VERSION });
}

/**
 * One structured line per request: request id (reqId), route pattern (no raw ids or query strings),
 * status, latency and a keyed hash of the caller's id. The incoming-request line is debug only.
 */
class AccessLog extends LogController {
  constructor(private readonly hashUser: (id: string) => string) {
    super();
  }
  override incomingRequest(request: FastifyRequest) {
    request.log.debug({ method: request.method, route: request.routeOptions?.url ?? 'unmatched' }, 'incoming request');
  }
  override requestCompleted(error: Error | null, request: FastifyRequest, reply: FastifyReply) {
    const line = {
      method: request.method, route: request.routeOptions?.url ?? 'unmatched', status: reply.statusCode, ms: Math.round(reply.elapsedTime),
      user: request.actorId ? this.hashUser(request.actorId) : null,
    };
    if (error) reply.log.error({ ...line, err: error }, 'request errored');
    else reply.log.info(line, 'request completed');
  }
}

export async function buildApp(deps: Deps, opts: { logger?: FastifyServerOptions['logger'] } = {}) {
  const hashUser = (id: string) => userHash(deps, id);
  const app = Fastify({
    logger: opts.logger ?? true,
    logController: new AccessLog(hashUser),
    // A well-formed id from the caller (or the edge) is kept so a request can be followed across services.
    genReqId: (req) => {
      const given = req.headers['x-request-id'];
      return typeof given === 'string' && REQUEST_ID.test(given) ? given : randomUUID();
    },
    bodyLimit: 1024 * 1024, // JSON only; video bytes go straight to object storage
    trustProxy: true,
  });
  // Bearer tokens, not cookies, so no credentials mode; only the configured web origins may call from a browser.
  const origins = deps.config.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  await app.register(cors, { origin: origins, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], credentials: false, maxAge: 600, exposedHeaders: ['x-request-id'] });
  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } });
  // In production the store is Redis so limits hold across instances.
  await app.register(rateLimit, {
    ...(deps.config.RATE_LIMIT_STORE === 'postgres' ? { store: postgresRateStore(deps.db), skipOnError: true } : {}),
    max: 300,
    timeWindow: '1 minute',
    // Signed-in callers are limited per token, everyone else per IP.
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      return auth ? `t:${createHash('sha256').update(auth).digest('hex').slice(0, 32)}` : `ip:${req.ip}`;
    },
  });
  const reporter = deps.errorReporter ?? new LogErrorReporter();
  app.setErrorHandler((err, req, reply) => problemHandler(err as Error, req, reply, reporter, hashUser));
  app.setNotFoundHandler((req, reply) => problemHandler(Object.assign(new Error('route not found'), { statusCode: 404, code: 'NOT_FOUND' }) as never, req, reply));

  // The request id is echoed back so clients can quote it in reports (see AccessLog for the log line).
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/v1/openapi.json', async () => openApiDocument());
  register(app, deps, routes.filter((r) => !r.rawBody));
  // Routes that verify a signature over the exact bytes get them unparsed, in their own scope.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    register(scope, deps, routes.filter((r) => r.rawBody));
  });
  return app;
}
