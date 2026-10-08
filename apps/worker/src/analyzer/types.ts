import { z } from 'zod';
import { SKILL_KEYS, MODERATION_VERDICTS } from '@fp/domain';

export const MODERATION_CATEGORIES = [
  'non_football', 'dangerous', 'sexual', 'harassment', 'hate', 'graphic_violence', 'illegal', 'copyright', 'spam', 'scam', 'child_safety',
] as const;
export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number];

/** Categories severe enough that an explicit AI `rejected` verdict may take the video down without waiting for a human. */
export const SEVERE_CATEGORIES: ReadonlySet<string> = new Set(['sexual', 'child_safety', 'graphic_violence', 'hate', 'illegal', 'dangerous', 'harassment']);

export const VIDEO_CONTEXTS = ['match', 'training', 'freestyle', 'other'] as const;

export const AnalysisSchema = z.object({
  footballPresent: z.boolean(),
  playersVisible: z.number().int().min(0).max(100),
  context: z.enum(VIDEO_CONTEXTS),
  skills: z.array(z.object({ key: z.enum(SKILL_KEYS), confidence: z.number().min(0).max(1) })).max(SKILL_KEYS.length),
  moderation: z.object({
    verdict: z.enum(MODERATION_VERDICTS),
    categories: z.array(z.enum(MODERATION_CATEGORIES)),
    explanation: z.string().max(2000),
  }),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

export interface AnalysisFrame {
  /** JPEG bytes. */
  data: Buffer;
  /** Position in the trimmed clip. */
  atMs: number;
}

export interface AnalysisInput {
  videoId: string;
  durationMs: number;
  width: number;
  height: number;
  frames: AnalysisFrame[];
}

export type AnalysisOutcome =
  | { kind: 'result'; analysis: Analysis; model: string }
  /** The model declined to analyse the content. Never published automatically; a human decides. */
  | { kind: 'refusal'; explanation: string; category: string | null; model: string };

export interface VideoAnalyzer {
  analyze(input: AnalysisInput): Promise<AnalysisOutcome>;
}
