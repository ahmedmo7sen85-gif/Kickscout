import type { Config } from './config.js';
import type { Database } from '@fp/db';
import type { TokenVerifier } from './platform/auth.js';
import type { ObjectStorage } from './platform/storage.js';
import type { Mailer } from './platform/mailer.js';
import type { PaymentProvider } from './platform/billing/provider.js';
import type { AiRouter } from '@fp/ai';

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
}
