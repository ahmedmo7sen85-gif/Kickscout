import { z } from 'zod';

const Env = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(8080),
    DATABASE_URL: z.string().min(1),
    AUTH_JWKS_URL: z.url(),
    AUTH_ISSUER: z.string().min(1),
    AUTH_AUDIENCE: z.string().min(1),
    S3_REGION: z.string().default('eu-central-1'),
    S3_ENDPOINT: z.url().optional(),
    S3_BUCKET_ORIGINALS: z.string().min(1),
    S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
    /** Leave unset on AWS to use the default credential chain. Never sent to the browser. */
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    CDN_BASE_URL: z.url(),
    /** base64-encoded 32-byte key for date-of-birth encryption. */
    DOB_ENCRYPTION_KEY: z.string().refine((k) => Buffer.from(k, 'base64').length === 32, 'must be 32 bytes, base64'),
    /** Secret for hashing signed-out viewers into daily view counts (no raw IPs are stored). */
    VIEWER_HASH_SECRET: z.string().min(32),
    MAILER: z.enum(['log', 'ses']).default('log'),
    /** 'yes' lets a labelled preview deployment run with MAILER=log (guardian emails are only logged). */
    ALLOW_LOG_MAILER: z.enum(['yes', 'no']).default('no'),
    POLICY_VERSION: z.string().default('2026-10-draft'),
    /** Comma-separated origins allowed to call the API from a browser (the web app). */
    CORS_ORIGINS: z.string().default('http://localhost:3000'),
    /** 'postgres' shares rate-limit counters across instances (needed on serverless hosts); 'memory' is per process. */
    RATE_LIMIT_STORE: z.enum(['memory', 'postgres']).default('memory'),
    /** Upload limits for the free plan until plans and entitlements exist. */
    MAX_VIDEO_SECONDS: z.coerce.number().int().min(5).max(600).default(60),
    MAX_ACTIVE_VIDEOS: z.coerce.number().int().min(1).default(20),
    MAX_UPLOADS_PER_DAY: z.coerce.number().int().min(1).default(10),
    /** Optional: the worker endpoint to wake after an upload completes (serverless worker). */
    WORKER_TRIGGER_URL: z.url().optional(),
    WORKER_TRIGGER_SECRET: z.string().min(32).optional(),
  })
  .refine((e) => !(e.NODE_ENV === 'production' && e.MAILER === 'log' && e.ALLOW_LOG_MAILER !== 'yes'), {
    message: 'MAILER=log is for development only; configure a real mailer in production',
    path: ['MAILER'],
  });

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid configuration:\n  ${issues}`);
  }
  return parsed.data;
}
