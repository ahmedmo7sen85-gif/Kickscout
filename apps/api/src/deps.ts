import type { Config } from './config.js';
import type { Database } from './db/db.js';
import type { TokenVerifier } from './platform/auth.js';
import type { ObjectStorage } from './platform/storage.js';
import type { Mailer } from './platform/mailer.js';

export interface Deps {
  config: Config;
  db: Database;
  verifier: TokenVerifier;
  storage: ObjectStorage;
  mailer: Mailer;
  dobKey: Buffer;
  now: () => Date;
}
