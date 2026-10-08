import { z } from 'zod';
import { AnalysisView, CreateAnalysisRequest } from '@fp/contracts';
import { capability } from '@fp/domain';
import type { CapabilityKey } from '@fp/domain';
import type { Deps } from '../deps.js';
import { route } from '../platform/route.js';
import { ApiError, conflict, forbidden, notFound } from '../platform/errors.js';
import { newId } from '../platform/ids.js';
import { audit, emit } from '../platform/events.js';
import { authorizeAnalysisView, recomputePlayer } from './intelligence.js';

export const PIPELINE_VERSION = 'pipeline-0.1.0';

const ANALYSIS_CAPABILITIES: CapabilityKey[] = [
  'analysis.video_quality', 'analysis.player_tracking', 'analysis.events', 'analysis.skill_scores',
  'analysis.movement', 'analysis.tactical', 'analysis.decision_making', 'intelligence.player_dna', 'intelligence.scouting_report',
];

async function analysisView(deps: Deps, id: string) {
  const r = await deps.db.selectFrom('analysis_runs').innerJoin('target_selections', 'target_selections.id', 'analysis_runs.target_selection_id')
    .select(['analysis_runs.id', 'analysis_runs.video_id', 'analysis_runs.status', 'analysis_runs.pipeline_version', 'analysis_runs.tier',
      'analysis_runs.quality_score', 'analysis_runs.readiness', 'analysis_runs.limitations', 'analysis_runs.created_at',
      'target_selections.frame_ms', 'target_selections.box', 'target_selections.confirmed', 'target_selections.claimed_player_id', 'analysis_runs.requested_by'])
    .where('analysis_runs.id', '=', id).executeTakeFirst();
  if (!r) throw notFound('analysis');
  return {
    raw: r,
    view: {
      id: r.id,
      videoId: r.video_id,
      status: r.status as never,
      pipelineVersion: r.pipeline_version,
      tier: r.tier as never,
      selection: { frameMs: r.frame_ms, box: r.box as never, confirmed: r.confirmed },
      quality: { score: r.quality_score, readiness: r.readiness, limitations: (r.limitations as string[]) ?? [] },
      capabilities: ANALYSIS_CAPABILITIES.map(capability),
      createdAt: r.created_at.toISOString(),
    },
  };
}

const WorkerObservation = z.object({
  skill: z.string().regex(/^[a-z_]{2,40}$/),
  eventType: z.string().max(60),
  outcome: z.enum(['success', 'fail', 'unknown']),
  tStartMs: z.number().int().min(0),
  tEndMs: z.number().int().min(0),
  confidence: z.number().min(0).max(1),
  context: z.object({ pressure: z.enum(['none', 'low', 'high', 'unknown']).optional() }).catchall(z.unknown()).default({}),
  excludedReason: z.string().max(60).nullable().optional(),
}).refine((o) => o.tEndMs >= o.tStartMs, 'tEndMs before tStartMs');

const WorkerResults = z.object({
  status: z.enum(['done', 'failed', 'rejected_quality']),
  quality: z.object({ score: z.number().min(0).max(100), readiness: z.number().min(0).max(1), limitations: z.array(z.string().max(200)) }).optional(),
  agentRuns: z.array(z.object({
    agent: z.string().max(60),
    version: z.string().max(40),
    status: z.enum(['ok', 'failed', 'skipped']),
    confidence: z.number().min(0).max(1).nullable().default(null),
    limitations: z.array(z.string().max(200)).default([]),
    errors: z.array(z.string().max(500)).default([]),
    latencyMs: z.number().int().min(0).optional(),
    costUsdMicros: z.number().int().min(0).optional(),
    cacheKey: z.string().max(200).optional(),
    observations: z.array(WorkerObservation).default([]),
  })).max(50),
});

export const analysisRoutes = [
  route(
    { method: 'post', path: '/v1/videos/:videoId/analyses', summary: 'Select the player in a frame and request analysis', tag: 'analysis', auth: 'user', body: CreateAnalysisRequest, response: AnalysisView, status: 202 },
    async (ctx) => {
      const me = ctx.me();
      const video = await ctx.deps.db.selectFrom('videos').select(['id', 'owner_user_id', 'status', 'subject', 'duration_ms'])
        .where('id', '=', z.uuid().parse(ctx.params.videoId)).where('status', '!=', 'deleted').executeTakeFirst();
      if (!video) throw notFound('video');
      ctx.authorize({ kind: 'analysis.request', videoOwnerId: video.owner_user_id });
      if (video.status !== 'ready') throw conflict('VIDEO_NOT_READY', 'the video is still processing');
      if (video.duration_ms !== null && ctx.body.frameMs > video.duration_ms) throw new ApiError(400, 'FRAME_OUT_OF_RANGE', 'frame is past the end of the video');
      if (ctx.body.tier === 'advanced') throw forbidden('PLAN_REQUIRED', 'advanced analysis needs a paid plan (Coming Soon)');

      // Identity is never inferred from appearance. "This is me" from the uploader is an explicit
      // confirmation; naming someone else waits for that player (or their guardian) to confirm.
      const claimed = ctx.body.claimedPlayerId ?? (video.subject === 'me' ? video.owner_user_id : null);
      if (claimed) {
        const isPlayer = await ctx.deps.db.selectFrom('player_profiles').select('user_id').where('user_id', '=', claimed).executeTakeFirst();
        if (!isPlayer) throw new ApiError(400, 'NOT_A_PLAYER', 'the named user has no player profile');
      }
      const confirmed = claimed !== null && (claimed === me.userId || me.guardianOf.includes(claimed));

      const inFlight = await ctx.deps.db.selectFrom('analysis_runs').select('id').where('video_id', '=', video.id).where('status', 'in', ['queued', 'running']).executeTakeFirst();
      if (inFlight) throw conflict('ANALYSIS_IN_PROGRESS', 'an analysis of this video is already running');

      const selectionId = newId();
      const runId = newId();
      await ctx.deps.db.transaction().execute(async (tx) => {
        await tx.insertInto('target_selections').values({
          id: selectionId, video_id: video.id, selected_by: me.userId, frame_ms: ctx.body.frameMs, box: JSON.stringify(ctx.body.box), claimed_player_id: claimed, confirmed,
        }).execute();
        await tx.insertInto('analysis_runs').values({
          id: runId, video_id: video.id, target_selection_id: selectionId, requested_by: me.userId, pipeline_version: PIPELINE_VERSION, tier: ctx.body.tier,
        }).execute();
        await emit(tx, 'analysis.requested', { analysisId: runId, videoId: video.id, pipelineVersion: PIPELINE_VERSION, tier: ctx.body.tier });
      });
      return (await analysisView(ctx.deps, runId)).view;
    },
  ),

  route(
    { method: 'get', path: '/v1/analyses/:analysisId', summary: 'Analysis status, quality and limitations', tag: 'analysis', auth: 'user', response: AnalysisView },
    async (ctx) => {
      const { raw, view } = await analysisView(ctx.deps, z.uuid().parse(ctx.params.analysisId));
      const me = ctx.me();
      if (raw.requested_by !== me.userId) {
        if (!raw.claimed_player_id || !raw.confirmed) throw notFound('analysis');
        await authorizeAnalysisView(ctx, raw.claimed_player_id);
      }
      return view;
    },
  ),

  route(
    { method: 'post', path: '/v1/selections/:selectionId/confirm', summary: 'The named player confirms it is them', tag: 'analysis', auth: 'user', status: 204 },
    async (ctx) => {
      const sel = await ctx.deps.db.selectFrom('target_selections').select(['id', 'claimed_player_id', 'confirmed'])
        .where('id', '=', z.uuid().parse(ctx.params.selectionId)).executeTakeFirst();
      if (!sel?.claimed_player_id) throw notFound('selection');
      ctx.authorize({ kind: 'selection.confirm', claimedPlayerId: sel.claimed_player_id });
      if (sel.confirmed) return;
      await ctx.deps.db.transaction().execute(async (tx) => {
        await tx.updateTable('target_selections').set({ confirmed: true }).where('id', '=', sel.id).execute();
        await audit(tx, { actorId: ctx.me().userId, action: 'selection.confirmed', targetKind: 'user', targetId: sel.claimed_player_id! });
        await recomputePlayer(tx, sel.claimed_player_id!);
      });
    },
  ),

  route(
    { method: 'post', path: '/internal/analyses/:analysisId/results', summary: 'AI pipeline submits agent outputs and observations', tag: 'internal', auth: 'service', body: WorkerResults, status: 204 },
    async (ctx) => {
      const analysisId = z.uuid().parse(ctx.params.analysisId);
      const b = ctx.body;
      await ctx.deps.db.transaction().execute(async (tx) => {
        const run = await tx.selectFrom('analysis_runs').innerJoin('target_selections', 'target_selections.id', 'analysis_runs.target_selection_id')
          .select(['analysis_runs.status', 'target_selections.claimed_player_id', 'target_selections.confirmed'])
          .where('analysis_runs.id', '=', analysisId).forUpdate().executeTakeFirst();
        if (!run) throw notFound('analysis');
        if (run.status !== 'queued' && run.status !== 'running') throw conflict('ALREADY_FINISHED', 'results were already recorded');

        let cost = 0;
        for (const a of b.agentRuns) {
          const agentRunId = newId();
          cost += a.costUsdMicros ?? 0;
          await tx.insertInto('agent_runs').values({
            id: agentRunId, analysis_run_id: analysisId, agent: a.agent, version: a.version, status: a.status, confidence: a.confidence,
            limitations: JSON.stringify(a.limitations), errors: JSON.stringify(a.errors), latency_ms: a.latencyMs ?? null,
            cost_usd_micros: a.costUsdMicros ?? null, cache_key: a.cacheKey ?? null,
          }).execute();
          if (a.observations.length) {
            await tx.insertInto('observations').values(a.observations.map((o) => ({
              id: newId(), analysis_run_id: analysisId, agent_run_id: agentRunId, skill: o.skill, event_type: o.eventType, outcome: o.outcome,
              t_start_ms: o.tStartMs, t_end_ms: o.tEndMs, confidence: o.confidence, context: JSON.stringify(o.context), excluded_reason: o.excludedReason ?? null,
            }))).execute();
          }
        }
        await tx.updateTable('analysis_runs').set({
          status: b.status,
          quality_score: b.quality?.score ?? null,
          readiness: b.quality?.readiness ?? null,
          limitations: JSON.stringify(b.quality?.limitations ?? []),
          cost_usd_micros: cost,
          finished_at: ctx.deps.now(),
        }).where('id', '=', analysisId).execute();

        if (b.status === 'done' && run.confirmed && run.claimed_player_id) await recomputePlayer(tx, run.claimed_player_id);
        await emit(tx, 'analysis.completed', { analysisId, status: b.status });
      });
    },
  ),
];
