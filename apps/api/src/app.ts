import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { buildOpenApi } from '@fp/contracts';
import type { Deps } from './deps.js';
import { problemHandler } from './platform/errors.js';
import { register, toRouteSpec } from './platform/route.js';
import { routes } from './routes.js';

export const API_VERSION = '0.1.0';

export function openApiDocument() {
  return buildOpenApi(routes.filter((r) => r.auth !== 'service').map(toRouteSpec), { title: 'Football Platform API', version: API_VERSION });
}

export async function buildApp(deps: Deps, opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger ?? true,
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024, // JSON only; video bytes go straight to object storage
    trustProxy: true,
  });
  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } });
  // In production the store is Redis so limits hold across instances.
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  app.setErrorHandler(problemHandler);
  app.setNotFoundHandler((req, reply) => problemHandler(Object.assign(new Error('route not found'), { statusCode: 404, code: 'NOT_FOUND' }) as never, req, reply));

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/v1/openapi.json', async () => openApiDocument());
  register(app, deps, routes);
  return app;
}
