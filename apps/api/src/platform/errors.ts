import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { ErrorReporter } from './error-reporter.js';
import { LogErrorReporter } from './error-reporter.js';

const defaultReporter = new LogErrorReporter();

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new ApiError(404, 'NOT_FOUND', `${what} not found`);
export const forbidden = (code: string, reason: string) => new ApiError(403, code, reason);
export const conflict = (code: string, reason: string) => new ApiError(409, code, reason);

const TITLES: Record<number, string> = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict',
  413: 'Payload Too Large', 422: 'Unprocessable Content', 429: 'Too Many Requests', 500: 'Internal Server Error', 503: 'Service Unavailable',
};

/** Hashes the caller id for error reports; set by the app (it holds the hashing secret). */
export type UserHasher = (userId: string) => string;

export function problemHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply, reporter: ErrorReporter = defaultReporter, hashUser?: UserHasher) {
  let status = 500;
  let code = 'INTERNAL';
  let detail: string | undefined = 'unexpected error';
  let errors: { path: string; message: string }[] | undefined;

  if (err instanceof ApiError) {
    status = err.status;
    code = err.code;
    detail = err.message;
  } else if (err instanceof ZodError) {
    status = 400;
    code = 'VALIDATION_FAILED';
    detail = 'request did not match the schema';
    errors = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  } else if ('statusCode' in err && typeof err.statusCode === 'number' && err.statusCode < 500) {
    status = err.statusCode;
    code = (err as FastifyError).code ?? 'BAD_REQUEST';
    detail = err.message;
  } else {
    reporter.capture(err, {
      requestId: req.id, method: req.method, route: req.routeOptions?.url ?? 'unmatched',
      userHash: req.actorId && hashUser ? hashUser(req.actorId) : null,
    }, req.log);
  }

  return reply
    .status(status)
    .type('application/problem+json')
    .send({ type: `urn:kickscout:error:${code.toLowerCase()}`, title: TITLES[status] ?? 'Error', status, code, detail, traceId: req.id, errors });
}
