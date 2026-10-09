import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { DB } from '@fp/db';
import { DEFAULT_GUARDIAN_POLICY, mergePolicy } from '@fp/domain';
import type { GuardianPolicy } from '@fp/domain';
import { estimateCostUsd } from '@fp/ai';
import type { MediaTools } from '../media.js';
import type { Logger } from '../pipeline.js';
import { ClassifierUnavailableError } from './classifiers.js';
import { DuplicateContentDetector } from './duplicates.js';
import { childSafetySignal, decide, screenFoundRisk, suspiciousMoments } from './engine.js';
import type { StageResult } from './engine.js';
import { detectSceneCuts, evenSubset, extractFramesAt, hashFrames, planDeepTimestamps, planScreenTimestamps } from './sampling.js';
import type { FrameHash } from './sampling.js';
import { textSignals, UnavailableAudioClassifier } from './text.js';
import type {
  AudioFindings, AudioSafetyClassifier, ClassifierInput, DeepFindings, DuplicateSignals, Frame, GuardianDecision, ScanFailure, VideoMetadataText, VisualClassifier,
} from './types.js';

export interface GuardianClassifiers {
  screen: VisualClassifier | null;
  deep: VisualClassifier<DeepFindings> | null;
  audio?: AudioSafetyClassifier;
}

export interface GuardianDeps {
  db: Kysely<DB>;
  media: MediaTools;
  /** null when no AI provider is configured: every scan fails closed to human review. */
  classifiers: GuardianClassifiers | null;
  policy?: GuardianPolicy;
  log: Logger;
  now?: () => Date;
}

export interface ScanInput {
  videoId: string;
  ownerId: string;
  ownerIsMinor: boolean;
  /** The processed (trimmed) clip on local disk: what would be published. */
  path: string;
  workDir: string;
  durationMs: number;
  width: number;
  height: number;
  hasAudio: boolean;
  sha256: Buffer;
  metadata: VideoMetadataText;
}

export interface ScanResult {
  decision: GuardianDecision;
  /** Which checks ran, in order. */
  stages: string[];
  framesAnalyzed: number;
  /** Every model that answered, e.g. "screen:claude-haiku-5-5;deep:claude-opus-5-5". */
  modelVersion: string | null;
  deepFindings: DeepFindings | null;
  hashes: FrameHash[];
  duplicates: DuplicateSignals;
  latencyMs: number;
}

/** GUARDIAN_POLICY (JSON) overrides the defaults; GUARDIAN_POLICY_VERSION names the result for audits and re-scans. */
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): GuardianPolicy {
  let override: unknown = null;
  if (env.GUARDIAN_POLICY?.trim()) {
    try {
      override = JSON.parse(env.GUARDIAN_POLICY);
    } catch {
      throw new Error('GUARDIAN_POLICY is not valid JSON');
    }
  }
  const policy = mergePolicy(DEFAULT_GUARDIAN_POLICY, override);
  return env.GUARDIAN_POLICY_VERSION?.trim() ? { ...policy, version: env.GUARDIAN_POLICY_VERSION.trim() } : policy;
}

/** Estimated AI spend since midnight UTC, from the ai_calls log. */
export async function spentTodayUsd(db: Kysely<DB>, now: Date): Promise<number> {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const rows = await db.selectFrom('ai_calls')
    .select([sql<string>`coalesce(response_model, model)`.as('m'), db.fn.sum<string>('input_tokens').as('i'), db.fn.sum<string>('output_tokens').as('o')])
    .where('created_at', '>=', day)
    .groupBy(sql`coalesce(response_model, model)`)
    .execute();
  return rows.reduce((sum, r) => sum + estimateCostUsd(r.m, Number(r.i ?? 0), Number(r.o ?? 0)), 0);
}

/**
 * FootballVideoSafetyService: the KICKSCOUT Guardian scan. Integrity is checked before this runs (see
 * pipeline.ts); here the clip is sampled across its whole length, hashed, screened, looked at again
 * around anything suspicious, and the evidence is combined into one decision by the Risk Decision
 * Engine. Mandatory for every upload: nothing about the uploader's plan or status changes it.
 */
export class FootballVideoSafetyService {
  readonly policy: GuardianPolicy;
  private readonly audio: AudioSafetyClassifier;
  private readonly duplicates: DuplicateContentDetector;

  constructor(private readonly deps: GuardianDeps) {
    this.policy = deps.policy ?? DEFAULT_GUARDIAN_POLICY;
    this.audio = deps.classifiers?.audio ?? new UnavailableAudioClassifier();
    this.duplicates = new DuplicateContentDetector(deps.db);
  }

  async scan(input: ScanInput): Promise<ScanResult> {
    const started = Date.now();
    const { policy } = this;
    const stages: string[] = [];
    const models: string[] = [];
    let failure: ScanFailure | null = null;
    let screen: StageResult | null = null;
    let deep: StageResult<DeepFindings> | null = null;
    let audio: AudioFindings | null = null;
    let framesAnalyzed = 0;

    const done = (decision: GuardianDecision, extra: { hashes: FrameHash[]; duplicates: DuplicateSignals }): ScanResult => ({
      decision, stages, framesAnalyzed,
      modelVersion: models.length ? models.join(';') : null,
      deepFindings: deep?.outcome.kind === 'result' ? deep.outcome.findings : null,
      latencyMs: Date.now() - started,
      ...extra,
    });

    // 1. Exact copies, before anything is sent anywhere.
    stages.push('duplicate');
    const exact = await this.duplicates.exact(input.videoId, input.ownerId, input.sha256);
    let duplicates: DuplicateSignals = { ...exact, similarRejected: null };
    const text = textSignals(input.metadata);
    const base = { policy, ownerIsMinor: input.ownerIsMinor, text, audio: null, failure: null };
    if (exact.exactRejected?.childSafety) {
      return done(decide({ ...base, screen: null, deep: null, duplicates }), { hashes: [], duplicates });
    }

    // 2. Frames across the whole clip, plus a frame after every scene cut.
    const cuts = await detectSceneCuts(this.deps.media, input.path, policy.sampling.sceneThreshold);
    const planned = planScreenTimestamps(input.durationMs, policy.sampling, cuts);
    const frames = await extractFramesAt(this.deps.media, input.path, input.workDir, planned, policy.sampling.frameLongSide);

    // 3. Edited copies of rejected videos.
    const hashes = await hashFrames(this.deps.media, frames);
    duplicates = { ...duplicates, similarRejected: await this.duplicates.similar(input.videoId, hashes, policy) };
    if (duplicates.similarRejected?.childSafety) {
      return done(decide({ ...base, screen: null, deep: null, duplicates }), { hashes, duplicates });
    }

    stages.push('text');
    const classifiers = this.deps.classifiers;
    if (!classifiers?.screen) failure = { reason: 'CLASSIFIER_UNAVAILABLE', detail: 'no AI provider is configured' };
    else if (frames.length === 0) failure = { reason: 'SCAN_INCOMPLETE', detail: 'no frames could be extracted' };
    else if (policy.dailyBudgetUsd > 0) {
      const spent = await spentTodayUsd(this.deps.db, this.deps.now?.() ?? new Date());
      if (spent >= policy.dailyBudgetUsd) failure = { reason: 'BUDGET_EXCEEDED', detail: `estimated AI spend today ${spent.toFixed(2)} USD` };
    }

    const classifierInput = (f: Frame[]): ClassifierInput => ({
      videoId: input.videoId, ownerId: input.ownerId, durationMs: input.durationMs, width: input.width, height: input.height, frames: f, metadata: input.metadata,
    });

    try {
      if (!failure && classifiers?.screen) {
        // 4. Screen every sampled frame.
        stages.push('screen');
        const out = await classifiers.screen.classify(classifierInput(frames));
        screen = { outcome: out, frames };
        models.push(`screen:${out.model}`);
        framesAnalyzed += frames.length;

        // A child-safety signal stops here: no further copies go to any provider.
        const stop = out.kind === 'refusal' || childSafetySignal(policy, input.ownerIsMinor, screen);
        if (!stop && classifiers.deep) {
          const risk = screenFoundRisk(policy, screen);
          if (risk || policy.deepPass === 'always') {
            // 5. A second, independent look: dense frames around each suspicious moment, plus an even sample.
            const moments = suspiciousMoments(policy, [screen]).map((m) => m.atMs);
            const extra = risk && moments.length
              ? await extractFramesAt(this.deps.media, input.path, input.workDir,
                planDeepTimestamps(input.durationMs, policy.sampling, moments, frames.map((f) => f.atMs)).map((atMs) => ({ atMs, source: 'deep' as const })),
                policy.sampling.frameLongSide)
              : [];
            const flagged = frames.filter((f) => moments.includes(f.atMs));
            const sample = evenSubset(frames.filter((f) => !moments.includes(f.atMs)), policy.sampling.taggingFrames);
            const deepFrames = [...flagged, ...sample, ...extra].sort((a, b) => a.atMs - b.atMs);
            stages.push('deep');
            const deepOut = await classifiers.deep.classify(classifierInput(deepFrames));
            deep = { outcome: deepOut, frames: deepFrames };
            models.push(`deep:${deepOut.model}`);
            framesAnalyzed += deepFrames.length;
          }
        }
      }
    } catch (err) {
      if (!(err instanceof ClassifierUnavailableError)) throw err; // transient errors: the job is retried
      failure = { reason: 'CLASSIFIER_UNAVAILABLE', detail: err.message };
    }

    // 6. Audio, where a provider exists.
    stages.push('audio');
    audio = await this.audio.analyze({ videoId: input.videoId, path: input.path, durationMs: input.durationMs, hasAudio: input.hasAudio });
    if (audio.model) models.push(`audio:${audio.model}`);

    // 7. One decision from all of it.
    const decision = decide({ ...base, screen, deep, audio, duplicates, failure });
    this.deps.log.info('guardian scan', { videoId: input.videoId, decision: decision.decision, reasons: decision.reasonCodes, frames: framesAnalyzed });
    return done(decision, { hashes, duplicates });
  }

  /** Persists this clip's frame hashes (after the decision, so a clip never matches itself). */
  storeHashes(videoId: string, hashes: readonly FrameHash[]) {
    return this.duplicates.store(videoId, hashes);
  }
}

export { DuplicateContentDetector };
