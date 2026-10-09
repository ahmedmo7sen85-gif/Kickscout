import { AiRouter, ClaudeProvider, dbCallRecorder, routingFromEnv } from '@fp/ai';
import type { AiProvider } from '@fp/ai';
import type { Database } from '@fp/db';
import { v7 as uuidv7 } from 'uuid';
import type { Logger } from '../pipeline.js';
import { AiDeepClassifier, AiScreeningClassifier } from './classifiers.js';
import type { GuardianClassifiers } from './service.js';
import { UnavailableAudioClassifier } from './text.js';

/** The Guardian's classifiers on one AI router (any provider behind the provider-neutral interface). */
export function guardianClassifiers(router: AiRouter): GuardianClassifiers {
  return { screen: new AiScreeningClassifier(router), deep: new AiDeepClassifier(router), audio: new UnavailableAudioClassifier() };
}

/**
 * The worker's AI router (model routing from AI_* env variables, every call recorded in `ai_calls`) and
 * the Guardian classifiers on top of it. Without a provider there are no classifiers: every scan fails
 * closed to human review and nothing is published automatically.
 */
export function createGuardianClassifiers(apiKey: string | undefined, db: Database, log: Logger, env: NodeJS.ProcessEnv = process.env, provider?: AiProvider): GuardianClassifiers | null {
  const p = provider ?? (apiKey ? ClaudeProvider.fromApiKey(apiKey) : null);
  if (!p) return null;
  const router = new AiRouter(p, routingFromEnv(env), {
    recorder: dbCallRecorder(db, uuidv7),
    onRecordError: (err) => log.warn('could not record an AI call', { error: err instanceof Error ? err.message : String(err) }),
  });
  return guardianClassifiers(router);
}
