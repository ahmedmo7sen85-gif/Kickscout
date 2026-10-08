import { z } from 'zod';
import type { Transaction } from 'kysely';
import { DnaView, SkillExplanationView } from '@fp/contracts';
import { buildPlayerDna, capability, scoreSkill } from '@fp/domain';
import type { AgeBand, Observation, Position } from '@fp/domain';
import type { DB } from '../db/types.js';
import type { Ctx } from '../platform/route.js';
import { route } from '../platform/route.js';
import { notFound } from '../platform/errors.js';
import { newId } from '../platform/ids.js';
import { emit } from '../platform/events.js';

/**
 * Recomputes a player's skill scores and Player DNA from every confirmed observation.
 * Deterministic: the same evidence always yields the same scores.
 */
export async function recomputePlayer(tx: Transaction<DB>, playerId: string): Promise<void> {
  const rows = await tx
    .selectFrom('observations')
    .innerJoin('analysis_runs', 'analysis_runs.id', 'observations.analysis_run_id')
    .innerJoin('target_selections', 'target_selections.id', 'analysis_runs.target_selection_id')
    .select([
      'observations.id', 'observations.skill', 'observations.event_type', 'observations.outcome', 'observations.t_start_ms',
      'observations.t_end_ms', 'observations.confidence', 'observations.context', 'observations.excluded_reason',
      'analysis_runs.readiness', 'analysis_runs.video_id',
    ])
    .where('target_selections.claimed_player_id', '=', playerId)
    .where('target_selections.confirmed', '=', true)
    .where('analysis_runs.status', '=', 'done')
    .execute();

  const observations: Observation[] = rows.map((r) => {
    const ctx = (r.context ?? {}) as { pressure?: string };
    const pressure = ['none', 'low', 'high'].includes(ctx.pressure ?? '') ? (ctx.pressure as Observation['pressure']) : 'unknown';
    return {
      id: r.id, skill: r.skill, eventType: r.event_type, outcome: r.outcome as Observation['outcome'], tStartMs: r.t_start_ms,
      tEndMs: r.t_end_ms, confidence: r.confidence, videoReadiness: r.readiness ?? 0, videoId: r.video_id, pressure,
      excludedReason: r.excluded_reason,
    };
  });

  const skills = [...new Set(observations.map((o) => o.skill))].sort();
  const scored = [];
  for (const skill of skills) {
    const s = scoreSkill(skill, observations);
    const id = newId();
    const previous = await tx.selectFrom('skill_scores').select('id').where('player_user_id', '=', playerId).where('skill', '=', skill).where('superseded_by', 'is', null).executeTakeFirst();
    await tx.insertInto('skill_scores').values({
      id, player_user_id: playerId, skill, score: s.score, status: s.status, confidence: s.confidence, evidence_count: s.evidenceCount,
      evidence_quality: s.evidenceQuality, method_version: s.methodVersion, explanation: JSON.stringify(s.explanation),
    }).execute();
    if (previous) await tx.updateTable('skill_scores').set({ superseded_by: id }).where('id', '=', previous.id).execute();
    if (s.evidence.length) {
      await tx.insertInto('skill_score_evidence').values(s.evidence.map((e) => ({ skill_score_id: id, observation_id: e.observationId, weight: e.weight }))).execute();
    }
    scored.push({ skill, score: s.score, confidence: s.confidence, evidenceCount: s.evidenceCount });
  }

  const facts = await tx.selectFrom('player_profiles').select(['primary_position', 'secondary_positions', 'preferred_foot']).where('user_id', '=', playerId).executeTakeFirst();
  const dna = buildPlayerDna(
    {
      primaryPosition: (facts?.primary_position as Position | null) ?? null,
      secondaryPositions: (facts?.secondary_positions ?? []) as Position[],
      preferredFoot: (facts?.preferred_foot as 'left' | 'right' | 'both' | null) ?? null,
    },
    scored,
  );
  const last = await tx.selectFrom('player_dna_versions').select((eb) => eb.fn.max('version').as('v')).where('player_user_id', '=', playerId).executeTakeFirst();
  const version = (last?.v ?? 0) + 1;
  await tx.insertInto('player_dna_versions').values({ id: newId(), player_user_id: playerId, version, method_version: dna.methodVersion, dna: JSON.stringify(dna) }).execute();
  await emit(tx, 'player.dna_updated', { playerId, version });
}

/** Who may see a player's analysis: self, guardian, admin; verified scouts for minors; anyone for public adults. */
export async function authorizeAnalysisView(ctx: Ctx<unknown, unknown>, playerId: string) {
  const subject = await ctx.deps.db.selectFrom('users')
    .innerJoin('age_records', 'age_records.user_id', 'users.id')
    .innerJoin('privacy_settings', 'privacy_settings.user_id', 'users.id')
    .select(['age_records.age_band', 'privacy_settings.profile_visibility'])
    .where('users.id', '=', playerId).where('users.status', '!=', 'deleted').executeTakeFirst();
  if (!subject) throw notFound('player');
  ctx.authorize({ kind: 'analysis.view', subjectId: playerId, subjectPublic: subject.profile_visibility === 'public', subjectAgeBand: subject.age_band as AgeBand });
}

const NO_EVIDENCE = {
  en: 'No analysis evidence yet. Upload a clip and request an analysis to start building Player DNA.',
  ar: 'لا توجد أدلة تحليل بعد. ارفع مقطعًا واطلب تحليلًا لبدء بناء الحمض النووي للاعب.',
};

export const intelligenceRoutes = [
  route(
    { method: 'get', path: '/v1/players/:playerId/dna', summary: 'Latest Player DNA version', tag: 'intelligence', auth: 'user', response: DnaView },
    async (ctx) => {
      const playerId = z.uuid().parse(ctx.params.playerId);
      await authorizeAnalysisView(ctx, playerId);
      const latest = await ctx.deps.db.selectFrom('player_dna_versions').select(['version', 'dna']).where('player_user_id', '=', playerId).orderBy('version', 'desc').executeTakeFirst();
      return {
        playerId,
        version: latest?.version ?? null,
        capability: capability('intelligence.player_dna'),
        dna: latest?.dna ?? null,
        message: latest ? null : NO_EVIDENCE,
      };
    },
  ),

  route(
    { method: 'get', path: '/v1/players/:playerId/skills/:skill', summary: 'Why a skill has its score: actions, clips, limitations', tag: 'intelligence', auth: 'user', response: SkillExplanationView },
    async (ctx) => {
      const playerId = z.uuid().parse(ctx.params.playerId);
      const skill = z.string().regex(/^[a-z_]{2,40}$/).parse(ctx.params.skill);
      await authorizeAnalysisView(ctx, playerId);
      const s = await ctx.deps.db.selectFrom('skill_scores').selectAll().where('player_user_id', '=', playerId).where('skill', '=', skill).where('superseded_by', 'is', null).executeTakeFirst();
      if (!s) throw notFound('skill score');
      const clips = await ctx.deps.db.selectFrom('skill_score_evidence')
        .innerJoin('observations', 'observations.id', 'skill_score_evidence.observation_id')
        .innerJoin('analysis_runs', 'analysis_runs.id', 'observations.analysis_run_id')
        .select(['observations.id', 'analysis_runs.video_id', 'observations.t_start_ms', 'observations.t_end_ms', 'observations.outcome', 'observations.confidence'])
        .where('skill_score_evidence.skill_score_id', '=', s.id).orderBy('observations.t_start_ms').limit(100).execute();
      const explanation = s.explanation as Record<string, unknown>;
      return {
        skill: s.skill,
        status: s.status as 'assessed' | 'insufficient_evidence',
        score: s.score,
        confidence: s.confidence,
        calibrated: false,
        evidenceCount: s.evidence_count,
        evidenceQuality: s.evidence_quality as 'low' | 'medium' | 'high',
        methodVersion: s.method_version,
        capability: capability('analysis.skill_scores'),
        explanation: explanation as never,
        clips: clips.map((c) => ({ observationId: c.id, videoId: c.video_id, tStartMs: c.t_start_ms, tEndMs: c.t_end_ms, outcome: c.outcome, confidence: c.confidence })),
      };
    },
  ),
];
