/**
 * OpenAPI 3.1 generation from the route table. JSON Schemas come from Zod directly.
 */
import { z } from 'zod';
import { Problem } from './schemas.js';

export interface RouteSpec {
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  path: string;
  summary: string;
  tag: string;
  auth: boolean;
  query?: z.ZodObject;
  body?: z.ZodType;
  response?: z.ZodType;
  status?: number;
}

const json = (schema: z.ZodType, io: 'input' | 'output') => z.toJSONSchema(schema, { io, unrepresentable: 'any' });

export function buildOpenApi(routes: readonly RouteSpec[], info: { title: string; version: string }) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const oasPath = r.path.replace(/:([a-zA-Z]+)/g, '{$1}');
    const pathParams = [...r.path.matchAll(/:([a-zA-Z]+)/g)].map((m) => ({
      name: m[1], in: 'path', required: true, schema: { type: 'string' },
    }));
    const queryParams = r.query
      ? Object.entries(r.query.shape).map(([name, s]) => ({
          name, in: 'query', required: !(s as z.ZodType).safeParse(undefined).success, schema: json(s as z.ZodType, 'input'),
        }))
      : [];
    const op: Record<string, unknown> = {
      summary: r.summary,
      tags: [r.tag],
      parameters: [...pathParams, ...queryParams],
      responses: {
        [String(r.status ?? 200)]: r.response
          ? { description: 'OK', content: { 'application/json': { schema: json(r.response, 'output') } } }
          : { description: 'No content' },
        default: { description: 'Error', content: { 'application/problem+json': { schema: json(Problem, 'output') } } },
      },
    };
    if (r.auth) op.security = [{ bearer: [] }];
    if (r.body) op.requestBody = { required: true, content: { 'application/json': { schema: json(r.body, 'input') } } };
    (paths[oasPath] ??= {})[r.method] = op;
  }
  return {
    openapi: '3.1.0',
    info,
    servers: [{ url: '/' }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    paths,
  };
}
