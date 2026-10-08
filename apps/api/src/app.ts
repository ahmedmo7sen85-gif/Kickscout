import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cors from '@fastify/cors';
import { createHash, randomUUID } from 'node:crypto';
import { buildOpenApi } from '@fp/contracts';
import type { Deps } from './deps.js';
import { problemHandler } from './platform/errors.js';
import { register, toRouteSpec } from './platform/route.js';
import { postgresRateStore } from './platform/rate-store.js';
import { routes } from './routes.js';

export const API_VERSION = '0.1.0';

export function openApiDocument() {
  return buildOpenApi(routes.map(toRouteSpec), { title: 'KICKSCOUT API', version: API_VERSION });
}

export async function buildApp(deps: Deps, opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger ?? true,
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024, // JSON only; video bytes go straight to object storage
    trustProxy: true,
  });
  // Bearer tokens, not cookies, so no credentials mode; only the configured web origins may call from a browser.
  const origins = deps.config.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  await app.register(cors, { origin: origins, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], credentials: false, maxAge: 600 });
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
  app.setErrorHandler(problemHandler);
  app.setNotFoundHandler((req, reply) => problemHandler(Object.assign(new Error('route not found'), { statusCode: 404, code: 'NOT_FOUND' }) as never, req, reply));

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/v1/openapi.json', async () => openApiDocument());
  register(app, deps, routes);
  return app;
}
