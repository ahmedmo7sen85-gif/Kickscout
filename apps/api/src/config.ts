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
    CDN_BASE_URL: z.url(),
    /** base64-encoded 32-byte key for date-of-birth encryption. */
    DOB_ENCRYPTION_KEY: z.string().refine((k) => Buffer.from(k, 'base64').length === 32, 'must be 32 bytes, base64'),
    /** Shared secret for internal callbacks from the media and AI services. */
    INTERNAL_SERVICE_TOKEN: z.string().min(32),
    MAILER: z.enum(['log', 'ses']).default('log'),
    POLICY_VERSION: z.string().default('2026-10-draft'),
  })
  .refine((e) => !(e.NODE_ENV === 'production' && e.MAILER === 'log'), {
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
