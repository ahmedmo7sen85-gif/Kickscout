import { loadConfig } from './config.js';
import { createDb } from './db/db.js';
import { buildApp } from './app.js';
import { JwtVerifier } from './platform/auth.js';
import { S3Storage } from './platform/storage.js';
import { LogMailer } from './platform/mailer.js';
import type { Deps } from './deps.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
let mailer: Deps['mailer'] | undefined;

const deps: Deps = {
  config,
  db,
  verifier: JwtVerifier.remote(config.AUTH_JWKS_URL, config.AUTH_ISSUER, config.AUTH_AUDIENCE),
  storage: new S3Storage(config.S3_BUCKET_ORIGINALS, config.S3_REGION, config.S3_ENDPOINT),
  get mailer() {
    if (!mailer) throw new Error('mailer not initialised');
    return mailer;
  },
  dobKey: Buffer.from(config.DOB_ENCRYPTION_KEY, 'base64'),
  now: () => new Date(),
};

const app = await buildApp(deps);
if (config.MAILER !== 'log') throw new Error('MAILER=ses is not implemented yet');
mailer = new LogMailer(app.log);

const shutdown = async () => {
  await app.close();
  await db.destroy();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: '0.0.0.0', port: config.PORT });
