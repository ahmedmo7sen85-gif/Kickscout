import { z } from 'zod';
import { GUARDIAN_CATEGORIES, SKILL_KEYS } from '@fp/domain';
import type { GuardianCategory, ReasonCode } from '@fp/domain';

/** One sampled still from the clip. */
export interface Frame {
  /** JPEG bytes. */
  data: Buffer;
  /** Position in the (trimmed) clip. */
  atMs: number;
  /** Why it was sampled: the even spread, a scene cut, or the dense look around a suspicious moment. */
  source: 'interval' | 'scene' | 'deep';
}

/** The uploader's own words. Untrusted data: shown to the models as content to moderate, never as instructions. */
export interface VideoMetadataText {
  title: string;
  description: string | null;
  hashtags: string[];
}

export interface ClassifierInput {
  videoId: string;
  ownerId: string;
  durationMs: number;
  width: number;
  height: number;
  frames: Frame[];
  metadata: VideoMetadataText;
}

const probability = z.number().min(0).max(1);
export const CategoryProbability = z.object({ category: z.enum(GUARDIAN_CATEGORIES), probability }).strict();
export type CategoryProbability = z.infer<typeof CategoryProbability>;

export const FOOTBALL_KINDS = ['match', 'training', 'skills', 'freestyle', 'goalkeeping', 'challenge', 'tactical', 'none'] as const;

/**
 * What a visual classifier says about a set of frames. Content probabilities only: nothing here rates
 * a player (the AI router refuses rating-like keys anyway).
 */
export const VisualFindings = z.object({
  /** Probability that the clip as a whole is genuine football content. */
  footballRelevance: probability,
  footballKind: z.enum(FOOTBALL_KINDS),
  /** A still picture (or slideshow of stills) rather than real footage. */
  staticImage: z.boolean(),
  /** People who may be under 18 appear. Used only to apply stricter child-safety rules. */
  minorsMayBePresent: z.boolean(),
  /** One entry per frame, in order, numbered from 1. */
  frames: z.array(z.object({ frame: z.number().int().min(1), football: z.boolean(), categories: z.array(CategoryProbability).max(GUARDIAN_CATEGORIES.length) }).strict()),
  /** Text visible in the frames (captions, overlays, signs). */
  onScreenText: z.array(CategoryProbability).max(GUARDIAN_CATEGORIES.length),
  /** The uploader's title, description and hashtags. */
  metadataText: z.array(CategoryProbability).max(GUARDIAN_CATEGORIES.length),
  confidence: probability,
  explanation: z.string().max(1000),
}).strict();
export type VisualFindings = z.infer<typeof VisualFindings>;

/** The deep pass also suggests skill tags (as before Guardian), shown to players as AI suggestions only. */
export const DeepFindings = VisualFindings.extend({
  playersVisible: z.number().int().min(0).max(100),
  context: z.enum(['match', 'training', 'freestyle', 'other']),
  skills: z.array(z.object({ key: z.enum(SKILL_KEYS), confidence: probability }).strict()).max(SKILL_KEYS.length),
}).strict();
export type DeepFindings = z.infer<typeof DeepFindings>;

export type ClassifierOutcome<T> =
  | { kind: 'result'; findings: T; model: string }
  /** The model declined to look. Never treated as approval. */
  | { kind: 'refusal'; model: string; explanation: string | null; category: string | null };

export interface VisualClassifier<T extends VisualFindings = VisualFindings> {
  readonly stage: 'screen' | 'deep';
  classify(input: ClassifierInput): Promise<ClassifierOutcome<T>>;
}

export interface AudioFindings {
  available: boolean;
  /** Why not, when unavailable. */
  reason?: 'no_audio_track' | 'no_provider' | 'disabled';
  categories: CategoryProbability[];
  model?: string;
}

/** Speech and sound checks. Pluggable: no speech-to-text provider is wired in yet. */
export interface AudioSafetyClassifier {
  analyze(input: { videoId: string; path: string; durationMs: number; hasAudio: boolean }): Promise<AudioFindings>;
}

export interface TextSignal {
  category: GuardianCategory;
  probability: number;
  /** Which field matched; the matched words are not stored. */
  field: 'title' | 'description' | 'hashtags';
  rule: string;
}

export interface SuspiciousMoment {
  atMs: number;
  categories: GuardianCategory[];
  probability: number;
}

export interface DuplicateSignals {
  /** Byte-identical to a video already rejected or removed for its content. */
  exactRejected: { videoId: string; childSafety: boolean } | null;
  /** Frames match a rejected video (perceptual hash, mirrored too). */
  similarRejected: { videoId: string; matchedFrames: number; share: number; childSafety: boolean } | null;
  /** Byte-identical to another user's live video (possible stolen clip). */
  otherOwnerDuplicate: string | null;
}

export type ScanFailure = { reason: Extract<ReasonCode, 'CLASSIFIER_UNAVAILABLE' | 'CLASSIFIER_ERROR' | 'SCAN_INCOMPLETE' | 'BUDGET_EXCEEDED'>; detail: string };

export type GuardianDecisionStatus = 'APPROVED' | 'REJECTED' | 'HUMAN_REVIEW' | 'SCAN_FAILED';

export interface GuardianDecision {
  decision: GuardianDecisionStatus;
  reasonCodes: ReasonCode[];
  /** Guardian categories at or above their review threshold, plus not_football when that applies. */
  categories: string[];
  /** Highest visual probability per category across every frame and stage. */
  categoryProbabilities: Partial<Record<GuardianCategory, number>>;
  footballRelevance: number | null;
  confidence: number | null;
  suspicious: SuspiciousMoment[];
  /** The highest-priority safety workflow applies: restricted case, legal hold, no further provider calls. */
  childSafety: boolean;
  /** Case priority: 0 child safety or a minor involved, 1 serious, 2 default, 3 football relevance only. */
  priority: number;
  reviewRequired: boolean;
  explanation: string | null;
}
