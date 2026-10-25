import type { Config } from './config.js';
import type { Database } from '@fp/db';
import type { TokenVerifier } from './platform/auth.js';
import type { ObjectStorage } from './platform/storage.js';
import type { Mailer } from './platform/mailer.js';
import type { PaymentProvider } from './platform/billing/provider.js';
import type { AiRouter } from '@fp/ai';
import type { ErrorReporter } from './platform/error-reporter.js';
import type { FootballService } from './platform/football.js';
import type { PushSender } from './platform/push.js';

export interface Deps {
  config: Config;
  db: Database;
  verifier: TokenVerifier;
  storage: ObjectStorage;
  mailer: Mailer;
  /** Null until payment keys are configured; billing endpoints then answer 503 BILLING_NOT_CONFIGURED. */
  billing: PaymentProvider | null;
  /** AI model routing; `available` is false without an API key (features fall back, nothing breaks). */
  ai: AiRouter;
  dobKey: Buffer;
  now: () => Date;
  /** Unexpected errors go here; defaults to a structured log line (LogErrorReporter). */
  errorReporter?: ErrorReporter;
  /** Football data through the shared cache; null/absent when FOOTBALL_PROVIDER=off (football endpoints answer 503). */
  football?: FootballService | null;
  /** Web Push sender; null/absent until VAPID keys are configured (alerts are then not sent). */
  push?: PushSender | null;
}
