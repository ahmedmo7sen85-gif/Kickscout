import { z } from 'zod';

const optionalString = z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().optional());
const bool = (fallback: boolean) =>
  z.preprocess((v) => (v === undefined || v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase())), z.boolean());

export const ConfigSchema = z.object({
  NODE_ENV: z.string().default('production'),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),

  // S3-compatible storage: AWS S3, Supabase Storage (S3 endpoint), Cloudflare R2, MinIO.
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: optionalString,
  S3_FORCE_PATH_STYLE: bool(false),
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,
  S3_BUCKET_ORIGINALS: z.string().min(1),
  S3_BUCKET_DELIVERY: z.string().min(1),

  // AI analysis. Without a key nothing is auto-published: every video goes to human review.
  ANTHROPIC_API_KEY: optionalString,
  AI_MODEL: z.string().min(1).default('claude-opus-5-5'),
  AI_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  // Server-side refusal fallbacks (Claude API only). Turn off when pointing at a gateway that rejects the beta.
  AI_SERVER_FALLBACKS: bool(true),

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  JOB_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(15 * 60_000),
  JOB_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(2_000),
  JOB_RETRY_BASE_MS: z.coerce.number().int().min(0).default(30_000),
  MAX_ORIGINAL_BYTES: z.coerce.number().int().min(1).default(500 * 1024 * 1024),

  FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
  FFPROBE_PATH: z.string().min(1).default('ffprobe'),
  WORK_DIR: optionalString,
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid worker configuration: ${issues}`);
  }
  return parsed.data;
}
