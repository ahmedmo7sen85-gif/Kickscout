import { z } from 'zod';
import { AI_EFFORTS } from './types.js';
import type { AiEffort, AiTask } from './types.js';

/**
 * Model routing. Heavy work (looking at video frames to tag skills and moderate) goes to the strong
 * model; light work (turning a scout's sentence into search filters) goes to the fast, cheap one.
 * Screening (the Guardian's first look at every frame sampled across a whole clip) is its own tier:
 * a cheap model with room for many images and a per-frame answer.
 */
export type AiTier = 'heavy' | 'light' | 'screen';

export const TASK_TIER: Record<AiTask, AiTier> = {
  video_analysis: 'heavy',
  video_screening: 'screen',
  nl_scout_query: 'light',
};

export interface RouteConfig {
  tier: AiTier;
  model: string;
  effort: AiEffort;
  /** Output token cap per call: the task's budget. */
  maxTokens: number;
  /** Per attempt. */
  timeoutMs: number;
  /** Total attempts, including the first. */
  maxAttempts: number;
  serverFallbacks: boolean;
}

export type RoutingTable = Record<AiTask, RouteConfig>;

export const DEFAULT_HEAVY_MODEL = 'claude-opus-5-5';
export const DEFAULT_LIGHT_MODEL = 'claude-haiku-5-5';
export const DEFAULT_SCREEN_MODEL = 'claude-haiku-5-5';

const unset = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const str = (d: string) => z.preprocess(unset, z.string().min(1).default(d));
const int = (d: number, min: number, max: number) => z.preprocess(unset, z.coerce.number().int().min(min).max(max).default(d));
const effort = (d: AiEffort) => z.preprocess(unset, z.enum(AI_EFFORTS).default(d));
const bool = (d: boolean) => z.preprocess((v) => (unset(v) === undefined ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase())), z.boolean());

/**
 * Env variables (all optional). `AI_MODEL` / `AI_EFFORT` are the worker's original names and still
 * apply to the heavy tier when the tier-specific variables are unset.
 */
const RoutingEnv = z.object({
  AI_MODEL: z.preprocess(unset, z.string().min(1).optional()),
  AI_EFFORT: z.preprocess(unset, z.enum(AI_EFFORTS).optional()),
  AI_MODEL_HEAVY: z.preprocess(unset, z.string().min(1).optional()),
  AI_EFFORT_HEAVY: z.preprocess(unset, z.enum(AI_EFFORTS).optional()),
  AI_MAX_TOKENS_HEAVY: int(16_000, 256, 128_000),
  AI_TIMEOUT_MS_HEAVY: int(5 * 60_000, 1_000, 15 * 60_000),
  AI_MAX_ATTEMPTS_HEAVY: int(3, 1, 6),
  AI_SERVER_FALLBACKS: bool(true),
  AI_MODEL_LIGHT: str(DEFAULT_LIGHT_MODEL),
  AI_EFFORT_LIGHT: effort('low'),
  AI_MAX_TOKENS_LIGHT: int(2_048, 256, 16_000),
  AI_TIMEOUT_MS_LIGHT: int(10_000, 500, 120_000),
  AI_MAX_ATTEMPTS_LIGHT: int(2, 1, 6),
  // Server-side refusal fallbacks are not available on every light model (Haiku has none): off by default.
  AI_SERVER_FALLBACKS_LIGHT: bool(false),
  AI_MODEL_SCREEN: str(DEFAULT_SCREEN_MODEL),
  AI_EFFORT_SCREEN: effort('low'),
  AI_MAX_TOKENS_SCREEN: int(12_000, 1_024, 64_000),
  AI_TIMEOUT_MS_SCREEN: int(2 * 60_000, 1_000, 10 * 60_000),
  AI_MAX_ATTEMPTS_SCREEN: int(3, 1, 6),
  AI_SERVER_FALLBACKS_SCREEN: bool(false),
});

export function routingFromEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): RoutingTable {
  const parsed = RoutingEnv.safeParse(env);
  if (!parsed.success) {
    throw new Error(`invalid AI routing configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const e = parsed.data;
  const tiers: Record<AiTier, Omit<RouteConfig, 'tier'>> = {
    heavy: {
      model: e.AI_MODEL_HEAVY ?? e.AI_MODEL ?? DEFAULT_HEAVY_MODEL,
      effort: e.AI_EFFORT_HEAVY ?? e.AI_EFFORT ?? 'high',
      maxTokens: e.AI_MAX_TOKENS_HEAVY,
      timeoutMs: e.AI_TIMEOUT_MS_HEAVY,
      maxAttempts: e.AI_MAX_ATTEMPTS_HEAVY,
      serverFallbacks: e.AI_SERVER_FALLBACKS,
    },
    light: {
      model: e.AI_MODEL_LIGHT,
      effort: e.AI_EFFORT_LIGHT,
      maxTokens: e.AI_MAX_TOKENS_LIGHT,
      timeoutMs: e.AI_TIMEOUT_MS_LIGHT,
      maxAttempts: e.AI_MAX_ATTEMPTS_LIGHT,
      serverFallbacks: e.AI_SERVER_FALLBACKS_LIGHT,
    },
    screen: {
      model: e.AI_MODEL_SCREEN,
      effort: e.AI_EFFORT_SCREEN,
      maxTokens: e.AI_MAX_TOKENS_SCREEN,
      timeoutMs: e.AI_TIMEOUT_MS_SCREEN,
      maxAttempts: e.AI_MAX_ATTEMPTS_SCREEN,
      serverFallbacks: e.AI_SERVER_FALLBACKS_SCREEN,
    },
  };
  return Object.fromEntries(Object.entries(TASK_TIER).map(([task, tier]) => [task, { tier, ...tiers[tier] }])) as RoutingTable;
}
