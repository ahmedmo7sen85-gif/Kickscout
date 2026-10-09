import { sql } from 'kysely';
import type { Kysely, Transaction } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { DB } from '@fp/db';
import { CATEGORY_SEVERITY, enforcementFor, STRIKE_DAYS, worstSeverity } from '@fp/domain';
import type { Severity } from '@fp/domain';
import type { GuardianDecision } from './types.js';

type Db = Kysely<DB> | Transaction<DB>;

export type ScanKind = 'upload' | 'rescan' | 'report' | 'policy_update';

/** What the player is told. Plain words, no internal scores or categories. */
export const USER_MESSAGES = {
  review: 'Your video is waiting for a moderator to check it before it is shown publicly.',
  notFootball: 'KICKSCOUT only hosts football videos, and this clip did not appear to show football. If it does, you can appeal.',
  staticImage: 'This upload looks like a still picture rather than video footage. Upload a real clip of you playing football.',
  rules: 'Your video was not published because it appears to break the community rules. You can appeal this decision.',
  reupload: 'This video matches one that was already removed for breaking the community rules. You can appeal this decision.',
  removed: 'Your video was removed because it appears to break the community rules. You can appeal this decision.',
} as const;

export function userMessage(d: GuardianDecision): string | null {
  if (d.decision === 'APPROVED') return null;
  // Child-safety cases get the neutral review notice, whatever the decision.
  if (d.childSafety || d.decision !== 'REJECTED') return USER_MESSAGES.review;
  if (d.reasonCodes.includes('NOT_FOOTBALL')) return USER_MESSAGES.notFootball;
  if (d.reasonCodes.includes('STATIC_IMAGE')) return USER_MESSAGES.staticImage;
  if (d.reasonCodes.includes('REUPLOAD_OF_REJECTED')) return USER_MESSAGES.reupload;
  return USER_MESSAGES.rules;
}

/** ModerationAuditService, part 1: the scan result row (the evidence behind a decision). */
export async function insertResult(db: Db, r: {
  videoId: string; scanKind: ScanKind; decision: GuardianDecision; stages: string[]; framesAnalyzed: number;
  modelVersion: string | null; policyVersion: string; latencyMs: number | null; retry?: Record<string, unknown> | null;
}): Promise<string> {
  const id = uuidv7();
  const d = r.decision;
  await db.insertInto('video_moderation_results').values({
    id, video_id: r.videoId, scan_kind: r.scanKind,
    football_relevance_score: d.footballRelevance, safety_scores: JSON.stringify(d.categoryProbabilities),
    detected_categories: d.categories, confidence: d.confidence, suspicious_timestamps: JSON.stringify(d.suspicious),
    frames_analyzed: r.framesAnalyzed, stages: r.stages, decision: d.decision, reason_codes: d.reasonCodes,
    review_required: d.reviewRequired, explanation: d.explanation?.slice(0, 2000) ?? null,
    model_version: r.modelVersion, policy_version: r.policyVersion, retry: r.retry ? JSON.stringify(r.retry) : null,
    latency_ms: r.latencyMs,
  }).execute();
  return id;
}

/** ModerationAuditService, part 2: an append-only audit entry, tied to the case when there is one. */
export async function auditEntry(db: Db, e: { actorId: string | null; action: string; videoId: string; caseId?: string | null; metadata?: Record<string, unknown> }) {
  await db.insertInto('audit_logs').values({
    actor_id: e.actorId, action: e.action, target_kind: 'video', target_id: e.videoId, case_id: e.caseId ?? null, metadata: JSON.stringify(e.metadata ?? {}),
  }).execute();
}

/**
 * HumanReviewRouter: opens a review case, or merges into the open case for the same video (one open
 * case per target). Child-safety cases are restricted to admins and always top priority.
 */
export async function routeToReview(db: Db, c: {
  videoId: string; ownerId: string; decision: GuardianDecision; resultId: string; source?: 'ai' | 'report' | 'appeal'; reason?: string | null;
}): Promise<string> {
  const d = c.decision;
  const verdict = JSON.stringify({
    decision: d.decision, reasonCodes: d.reasonCodes, footballRelevance: d.footballRelevance, confidence: d.confidence,
    categoryProbabilities: d.categoryProbabilities, suspicious: d.suspicious, explanation: d.explanation,
  });
  const categories = d.categories.length ? d.categories : d.reasonCodes.filter((r) => r !== 'AUDIO_NOT_CHECKED').map((r) => r.toLowerCase());
  const { rows } = await sql<{ id: string }>`
    INSERT INTO moderation_cases (id, target_kind, target_id, source, categories, ai_verdict, priority, user_id, reason, restricted, result_id)
    VALUES (${uuidv7()}, 'video', ${c.videoId}, ${c.source ?? 'ai'}, ${categories}, ${verdict}::jsonb, ${d.priority}, ${c.ownerId},
            ${c.reason ?? d.reasonCodes.join(', ')}, ${d.childSafety}, ${c.resultId})
    ON CONFLICT (target_kind, target_id) WHERE status = 'open' DO UPDATE SET
      categories = ARRAY(SELECT DISTINCT unnest(moderation_cases.categories || EXCLUDED.categories) ORDER BY 1),
      ai_verdict = EXCLUDED.ai_verdict,
      priority = LEAST(moderation_cases.priority, EXCLUDED.priority),
      restricted = moderation_cases.restricted OR EXCLUDED.restricted,
      result_id = EXCLUDED.result_id,
      user_id = coalesce(moderation_cases.user_id, EXCLUDED.user_id)
    RETURNING id`.execute(db);
  return rows[0]!.id;
}

/**
 * Records a strike for a confirmed violation and applies the enforcement ladder to the account:
 * upload restrictions, then suspension. Returns what was applied.
 */
export async function applyStrike(db: Db, s: {
  userId: string; videoId: string | null; caseId: string | null; categories: string[]; source: 'auto' | 'reviewer'; now: Date; actorId?: string | null;
}): Promise<{ severity: Severity; enforcement: ReturnType<typeof enforcementFor> } | null> {
  const severity = s.categories.includes('not_football') && !worstSeverity(s.categories) ? 'minor' : worstSeverity(s.categories);
  if (!severity) return null;
  const category = s.categories.find((c) => (CATEGORY_SEVERITY as Record<string, string>)[c] === severity) ?? s.categories[0]!;
  await db.insertInto('account_strikes').values({
    id: uuidv7(), user_id: s.userId, video_id: s.videoId, case_id: s.caseId, category, severity, source: s.source,
    expires_at: new Date(s.now.getTime() + STRIKE_DAYS[severity] * 86_400_000),
  }).onConflict((oc) => oc.doNothing()).execute();
  const active = await db.selectFrom('account_strikes').select(['severity', 'created_at'])
    .where('user_id', '=', s.userId).where('voided_at', 'is', null).where('expires_at', '>', s.now).execute();
  const enforcement = enforcementFor(active.map((a) => ({ severity: a.severity as Severity, createdAt: a.created_at })));
  if (enforcement.action === 'restrict_uploads') {
    const until = new Date(s.now.getTime() + enforcement.days * 86_400_000);
    await db.updateTable('users').set({ upload_restricted_until: until, upload_restriction_reason: 'Repeated community rule violations' })
      .where('id', '=', s.userId)
      .where((eb) => eb.or([eb('upload_restricted_until', 'is', null), eb('upload_restricted_until', '<', until)]))
      .execute();
  } else if (enforcement.action === 'suspend') {
    await db.updateTable('users').set({ status: 'suspended' }).where('id', '=', s.userId).where('status', '=', 'active').execute();
  }
  if (enforcement.action !== 'none') {
    await db.insertInto('audit_logs').values({
      actor_id: s.actorId ?? null, action: `guardian.enforcement.${enforcement.action}`, target_kind: 'user', target_id: s.userId, case_id: s.caseId,
      metadata: JSON.stringify({ severity, ...(enforcement.action === 'restrict_uploads' ? { days: enforcement.days } : {}), videoId: s.videoId }),
    }).execute();
  }
  return { severity, enforcement };
}

/** While a child-safety case is investigated the account cannot upload. */
export async function holdUploadsForInvestigation(db: Db, userId: string, now: Date) {
  await db.updateTable('users')
    .set({ upload_restricted_until: new Date(now.getTime() + 3650 * 86_400_000), upload_restriction_reason: 'Safety investigation' })
    .where('id', '=', userId).execute();
}
