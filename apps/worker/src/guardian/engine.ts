import { CATEGORY_SEVERITY, GUARDIAN_CATEGORIES, SEXUAL_CATEGORIES, thresholdsFor } from '@fp/domain';
import type { GuardianCategory, GuardianPolicy, ReasonCode } from '@fp/domain';
import type {
  AudioFindings, ClassifierOutcome, DeepFindings, DuplicateSignals, Frame, GuardianDecision, ScanFailure, SuspiciousMoment, TextSignal, VisualFindings,
} from './types.js';

export interface StageResult<T extends VisualFindings = VisualFindings> {
  outcome: ClassifierOutcome<T>;
  /** The frames sent, in the order they were numbered (frame n is frames[n - 1]). */
  frames: readonly Pick<Frame, 'atMs'>[];
}

export interface EngineInput {
  policy: GuardianPolicy;
  /** The uploader is under 18 (or their age is unknown). */
  ownerIsMinor: boolean;
  screen: StageResult | null;
  deep: StageResult<DeepFindings> | null;
  text: readonly TextSignal[];
  audio: AudioFindings | null;
  duplicates: DuplicateSignals;
  /** The scan could not finish: no provider, a permanent provider error, the budget, or missing media. */
  failure: ScanFailure | null;
}

type Probabilities = Partial<Record<GuardianCategory, number>>;

const CRITICAL: GuardianCategory[] = GUARDIAN_CATEGORIES.filter((c) => CATEGORY_SEVERITY[c] === 'critical');

function maxInto(target: Probabilities, category: GuardianCategory, p: number) {
  target[category] = Math.max(target[category] ?? 0, p);
}

/** Highest probability per category over every frame of one stage. */
function frameMaxima(stage: StageResult | null): Probabilities {
  const out: Probabilities = {};
  if (stage?.outcome.kind !== 'result') return out;
  for (const f of stage.outcome.findings.frames) for (const c of f.categories) maxInto(out, c.category, c.probability);
  return out;
}

function listMaxima(lists: readonly (readonly { category: GuardianCategory; probability: number }[])[]): Probabilities {
  const out: Probabilities = {};
  for (const list of lists) for (const c of list) maxInto(out, c.category, c.probability);
  return out;
}

function mergeMax(...all: Probabilities[]): Probabilities {
  const out: Probabilities = {};
  for (const p of all) for (const [k, v] of Object.entries(p)) maxInto(out, k as GuardianCategory, v);
  return out;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Moments where a frame reaches a category's review threshold, for reviewers and for the deep pass. */
export function suspiciousMoments(policy: GuardianPolicy, stages: readonly (StageResult | null)[]): SuspiciousMoment[] {
  const byTime = new Map<number, SuspiciousMoment>();
  for (const stage of stages) {
    if (stage?.outcome.kind !== 'result') continue;
    for (const f of stage.outcome.findings.frames) {
      const at = stage.frames[f.frame - 1]?.atMs;
      if (at === undefined) continue;
      const hits = f.categories.filter((c) => c.probability >= thresholdsFor(policy, c.category).review);
      if (hits.length === 0) continue;
      const m = byTime.get(at) ?? { atMs: at, categories: [], probability: 0 };
      for (const h of hits) {
        if (!m.categories.includes(h.category)) m.categories.push(h.category);
        m.probability = Math.max(m.probability, round3(h.probability));
      }
      byTime.set(at, m);
    }
  }
  return [...byTime.values()].sort((a, b) => a.atMs - b.atMs);
}

/** True when the screen alone already calls for the child-safety workflow (and so for no further provider calls). */
export function childSafetySignal(policy: GuardianPolicy, ownerIsMinor: boolean, screen: StageResult | null): boolean {
  if (screen?.outcome.kind !== 'result') return false;
  const p = frameMaxima(screen);
  if (CRITICAL.some((c) => (p[c] ?? 0) >= policy.childSafetySignal)) return true;
  const minors = ownerIsMinor || screen.outcome.findings.minorsMayBePresent;
  return minors && [...SEXUAL_CATEGORIES].some((c) => (p[c] ?? 0) >= thresholdsFor(policy, c).review);
}

/** Whether the screen found anything that calls for the deep pass on dense frames. */
export function screenFoundRisk(policy: GuardianPolicy, screen: StageResult | null): boolean {
  if (screen?.outcome.kind !== 'result') return true;
  const f = screen.outcome.findings;
  if (suspiciousMoments(policy, [screen]).length > 0) return true;
  if (f.staticImage || f.confidence < policy.minConfidence) return true;
  return f.footballRelevance < policy.football.approveMin;
}

function refusalLooksChildSafety(category: string | null, explanation: string | null) {
  return /child|minor|csam|csae|exploit/i.test(`${category ?? ''} ${explanation ?? ''}`);
}

/**
 * The Risk Decision Engine. Turns everything the scan learned into one decision. Only clearly safe,
 * clearly football clips are approved without a person; only clear, confirmed violations are rejected
 * without one; everything uncertain goes to human review; a scan that could not finish never approves.
 */
export function decide(input: EngineInput): GuardianDecision {
  const { policy } = input;
  const reasons = new Set<ReasonCode>();
  const screen = input.screen?.outcome.kind === 'result' ? input.screen.outcome.findings : null;
  const deep = input.deep?.outcome.kind === 'result' ? input.deep.outcome.findings : null;

  const screenP = frameMaxima(input.screen);
  const deepP = frameMaxima(input.deep);
  const visual = mergeMax(screenP, deepP);
  const onScreenText = listMaxima([screen?.onScreenText ?? [], deep?.onScreenText ?? []]);
  const metadataText = mergeMax(listMaxima([screen?.metadataText ?? [], deep?.metadataText ?? []]), listMaxima([input.text]));
  const audio = listMaxima([input.audio?.available ? input.audio.categories : []]);
  const suspicious = suspiciousMoments(policy, [input.screen, input.deep]);
  const minorsMayBePresent = input.ownerIsMinor || !!screen?.minorsMayBePresent || !!deep?.minorsMayBePresent;

  const relevance = screen && deep ? Math.min(screen.footballRelevance, deep.footballRelevance) : (deep ?? screen)?.footballRelevance ?? null;
  const confidence = screen && deep ? Math.min(screen.confidence, deep.confidence) : (deep ?? screen)?.confidence ?? null;
  const explanation = deep?.explanation ?? screen?.explanation ?? null;

  const atReview = (p: Probabilities) => (Object.keys(p) as GuardianCategory[]).filter((c) => (p[c] ?? 0) >= thresholdsFor(policy, c).review);
  const visualHits = atReview(visual);
  const categories = new Set<string>(visualHits);

  const result = (decision: GuardianDecision['decision'], extra: { childSafety?: boolean; priority?: number } = {}): GuardianDecision => {
    const childSafety = extra.childSafety ?? false;
    const serious = [...categories].some((c) => (CATEGORY_SEVERITY as Record<string, string>)[c] === 'serious' || (CATEGORY_SEVERITY as Record<string, string>)[c] === 'critical');
    const sexualWithMinor = minorsMayBePresent && [...categories].some((c) => SEXUAL_CATEGORIES.has(c as GuardianCategory));
    const footballOnly = [...reasons].every((r) => ['FOOTBALL_UNCERTAIN', 'FOOTBALL_PARTIAL', 'AUDIO_NOT_CHECKED', 'LOW_CONFIDENCE'].includes(r));
    const priority = extra.priority ?? (childSafety || sexualWithMinor ? 0
      : serious || reasons.has('SIMILAR_TO_REJECTED') || reasons.has('REUPLOAD_OF_REJECTED') || reasons.has('CLASSIFIER_REFUSED') ? 1
      : footballOnly ? 3 : 2);
    if (input.audio && !input.audio.available) reasons.add('AUDIO_NOT_CHECKED');
    return {
      decision,
      reasonCodes: [...reasons],
      categories: [...categories],
      categoryProbabilities: Object.fromEntries(Object.entries(visual).map(([k, v]) => [k, round3(v)])),
      footballRelevance: relevance === null ? null : round3(relevance),
      confidence: confidence === null ? null : round3(confidence),
      suspicious,
      childSafety,
      priority,
      reviewRequired: decision === 'HUMAN_REVIEW' || decision === 'SCAN_FAILED' || childSafety,
      explanation,
    };
  };

  // 1. Child safety comes first: a known match or any credible signal, whatever else is true.
  const dup = input.duplicates;
  if (dup.exactRejected?.childSafety || dup.similarRejected?.childSafety) {
    reasons.add('CHILD_SAFETY');
    reasons.add(dup.exactRejected?.childSafety ? 'REUPLOAD_OF_REJECTED' : 'SIMILAR_TO_REJECTED');
    categories.add('child_sexual_content');
    return result(dup.exactRejected?.childSafety ? 'REJECTED' : 'HUMAN_REVIEW', { childSafety: true, priority: 0 });
  }
  const critical = CRITICAL.filter((c) => (visual[c] ?? 0) >= policy.childSafetySignal);
  const sexual = [...SEXUAL_CATEGORIES].filter((c) => (visual[c] ?? 0) >= thresholdsFor(policy, c).review);
  if (critical.length > 0 || (minorsMayBePresent && sexual.length > 0)) {
    reasons.add('CHILD_SAFETY');
    if (minorsMayBePresent) reasons.add('MINOR_INVOLVED');
    for (const c of [...critical, ...sexual]) categories.add(c);
    const clear = critical.some((c) => (visual[c] ?? 0) >= (thresholdsFor(policy, c).reject ?? 1));
    return result(clear ? 'REJECTED' : 'HUMAN_REVIEW', { childSafety: true, priority: 0 });
  }
  if (input.screen?.outcome.kind === 'refusal' || input.deep?.outcome.kind === 'refusal') {
    const r = input.deep?.outcome.kind === 'refusal' ? input.deep.outcome : (input.screen!.outcome as Extract<ClassifierOutcome<VisualFindings>, { kind: 'refusal' }>);
    reasons.add('CLASSIFIER_REFUSED');
    const childSafety = refusalLooksChildSafety(r.category, r.explanation);
    if (childSafety) reasons.add('CHILD_SAFETY');
    return result('HUMAN_REVIEW', { childSafety, priority: childSafety ? 0 : 1 });
  }

  // 2. A scan that could not finish never approves.
  if (input.failure) {
    reasons.add(input.failure.reason);
    return result('SCAN_FAILED');
  }
  if (!screen) {
    reasons.add('SCAN_INCOMPLETE');
    return result('SCAN_FAILED');
  }

  // 3. Clear, confirmed violations. Rejection needs the deep pass to confirm what the screen saw.
  const footballFrames = screen.frames.filter((f) => f.football).length;
  const frameShare = screen.frames.length ? footballFrames / screen.frames.length : 0;
  const confident = (confidence ?? 0) >= policy.minConfidence;
  const confirmed = (Object.keys(deepP) as GuardianCategory[]).filter((c) => {
    const reject = thresholdsFor(policy, c).reject;
    return reject !== null && (deepP[c] ?? 0) >= reject;
  });
  if (confirmed.length > 0 && confident) {
    reasons.add('PROHIBITED_CONTENT');
    if (footballFrames > 0) reasons.add('DISGUISED_CONTENT');
    return result('REJECTED');
  }
  if (dup.exactRejected) {
    reasons.add('REUPLOAD_OF_REJECTED');
    return result('REJECTED');
  }
  const staticVotes = [screen.staticImage, ...(deep ? [deep.staticImage] : [])];
  if (staticVotes.every(Boolean) && confident) {
    reasons.add('STATIC_IMAGE');
    return result('REJECTED');
  }
  const maxRelevance = Math.max(screen.footballRelevance, deep?.footballRelevance ?? 0);
  const deepFootballFrames = deep ? deep.frames.filter((f) => f.football).length : 0;
  if (maxRelevance <= policy.football.rejectMax && footballFrames === 0 && deepFootballFrames === 0 && confident && visualHits.length === 0) {
    reasons.add('NOT_FOOTBALL');
    categories.add('not_football');
    return result('REJECTED');
  }

  // 4. Anything uncertain goes to a person.
  const screenOnlyRejectLevel = (Object.keys(screenP) as GuardianCategory[]).some((c) => {
    const reject = thresholdsFor(policy, c).reject;
    return reject !== null && (screenP[c] ?? 0) >= reject;
  });
  if (deep && screenOnlyRejectLevel && confirmed.length === 0) reasons.add('CONFLICTING_MODELS');
  if (confirmed.length > 0) reasons.add('LOW_CONFIDENCE');
  if (visualHits.length > 0) {
    reasons.add('POSSIBLE_PROHIBITED_CONTENT');
    if (footballFrames > 0 && visualHits.some((c) => CATEGORY_SEVERITY[c] !== 'minor')) reasons.add('DISGUISED_CONTENT');
  }
  if (staticVotes.some(Boolean)) reasons.add('STATIC_IMAGE');
  if ((relevance ?? 0) < policy.football.approveMin) {
    reasons.add('FOOTBALL_UNCERTAIN');
    if (maxRelevance <= policy.football.rejectMax) categories.add('not_football');
  } else if (frameShare < policy.football.minFrameShare) {
    reasons.add('FOOTBALL_PARTIAL');
  }
  const textHits = atLevel(mergeMax(metadataText), policy.textReview);
  if (textHits.length > 0) reasons.add('TEXT_SIGNAL');
  if (atLevel(onScreenText, policy.textReview).length > 0) reasons.add('ON_SCREEN_TEXT_SIGNAL');
  for (const c of [...textHits, ...atLevel(onScreenText, policy.textReview)]) categories.add(c);
  if (atReview(audio).length > 0) {
    reasons.add('AUDIO_SIGNAL');
    for (const c of atReview(audio)) categories.add(c);
  }
  if (dup.similarRejected) reasons.add('SIMILAR_TO_REJECTED');
  if (dup.otherOwnerDuplicate) reasons.add('DUPLICATE_OF_OTHER_OWNER');
  if (!confident) reasons.add('LOW_CONFIDENCE');
  if (deep && Math.abs(screen.footballRelevance - deep.footballRelevance) >= 0.5) reasons.add('CONFLICTING_MODELS');

  const blocking = [...reasons].filter((r) => r !== 'AUDIO_NOT_CHECKED');
  if (blocking.length > 0) return result('HUMAN_REVIEW');

  // 5. Clearly football, nothing prohibited, confident, and both looks agree.
  reasons.add('FOOTBALL_CONFIRMED');
  reasons.add('NO_PROHIBITED_CONTENT');
  return result('APPROVED');
}

function atLevel(p: Probabilities, level: number): GuardianCategory[] {
  return (Object.keys(p) as GuardianCategory[]).filter((c) => (p[c] ?? 0) >= level);
}

export type { DeepFindings };
