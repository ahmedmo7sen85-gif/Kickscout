import { AiRouter, ClaudeProvider, dbCallRecorder, routingFromEnv } from '@fp/ai';
import type { Database } from '@fp/db';
import { v7 as uuidv7 } from 'uuid';
import { AiVideoAnalyzer } from './claude.js';
import type { Logger } from '../pipeline.js';

/**
 * The worker's AI router (model routing from AI_* env variables, every call recorded in `ai_calls`) and
 * the video analyzer on top of it. Without an API key there is no analyzer: every upload waits for a
 * human, as before.
 */
export function createVideoAnalyzer(apiKey: string | undefined, db: Database, log: Logger, env: NodeJS.ProcessEnv = process.env): AiVideoAnalyzer | null {
  if (!apiKey) return null;
  const router = new AiRouter(ClaudeProvider.fromApiKey(apiKey), routingFromEnv(env), {
    recorder: dbCallRecorder(db, uuidv7),
    onRecordError: (err) => log.warn('could not record an AI call', { error: err instanceof Error ? err.message : String(err) }),
  });
  return new AiVideoAnalyzer(router);
}
