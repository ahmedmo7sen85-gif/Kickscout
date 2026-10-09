import { sql } from 'kysely';
import { AI_TASKS } from '@fp/ai';
import { AiUsageQuery, AiUsageView } from '@fp/contracts';
import { route } from '../platform/route.js';

export const aiAdminRoutes = [
  route(
    { method: 'get', path: '/v1/admin/ai/usage', summary: 'AI routing and cost accounting: calls, tokens, latency and outcomes per task and model', tag: 'admin', auth: 'user', query: AiUsageQuery, response: AiUsageView },
    async (ctx) => {
      ctx.authorize({ kind: 'admin.access' });
      const since = new Date(ctx.deps.now().getTime() - ctx.query.days * 86_400_000);
      const rows = await ctx.deps.db.selectFrom('ai_calls')
        .select([
          'task', sql<string>`coalesce(response_model, model)`.as('model'),
          sql<number>`count(*)::int`.as('calls'),
          sql<number>`(count(*) filter (where outcome = 'ok'))::int`.as('ok'),
          sql<number>`(count(*) filter (where outcome <> 'ok'))::int`.as('failed'),
          sql<number>`coalesce(sum(input_tokens), 0)::int`.as('input_tokens'),
          sql<number>`coalesce(sum(output_tokens), 0)::int`.as('output_tokens'),
          sql<number>`coalesce(round(avg(latency_ms)), 0)::int`.as('avg_latency'),
        ])
        .where('created_at', '>=', since)
        .groupBy(['task', sql`coalesce(response_model, model)`])
        .orderBy('task').orderBy(sql`coalesce(response_model, model)`)
        .execute();
      return {
        since: since.toISOString(),
        available: ctx.deps.ai.available,
        routes: AI_TASKS.map((task) => {
          const r = ctx.deps.ai.route(task);
          return { task, tier: r.tier, model: r.model, effort: r.effort, maxTokens: r.maxTokens, timeoutMs: r.timeoutMs };
        }),
        items: rows.map((r) => ({
          task: r.task, model: r.model, calls: r.calls, ok: r.ok, failed: r.failed, inputTokens: r.input_tokens, outputTokens: r.output_tokens, avgLatencyMs: r.avg_latency,
        })),
      };
    },
  ),
];
