import type { Database } from '@fp/db';
import type { AiCallRecord, AiCallRecorder } from './router.js';

/** Writes every AI attempt to `ai_calls` (task, model, tokens, latency, outcome, video/user). */
export function dbCallRecorder(db: Database, newId: () => string): AiCallRecorder {
  return {
    async record(r: AiCallRecord) {
      await db.insertInto('ai_calls').values({
        id: newId(), task: r.task, provider: r.provider, model: r.model, response_model: r.responseModel, effort: r.effort,
        input_tokens: r.inputTokens, output_tokens: r.outputTokens, latency_ms: r.latencyMs, outcome: r.outcome, attempt: r.attempt,
        video_id: r.videoId, user_id: r.userId, error: r.error,
      }).execute();
    },
  };
}
