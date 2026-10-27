import { loadConfig } from './config.js';
import { createDb } from '@fp/db';
import { buildApp } from './app.js';
import { JwtVerifier } from './platform/auth.js';
import { S3Storage } from './platform/storage.js';
import { LogMailer } from './platform/mailer.js';
import { StripePaymentProvider } from './platform/billing/stripe.js';
import type { Deps } from './deps.js';
import { AiRouter, ClaudeProvider, dbCallRecorder, routingFromEnv } from '@fp/ai';
import { newId } from './platform/ids.js';
import { FootballService, footballProviderFromConfig } from './platform/football.js';
import { pushSenderFromConfig } from './platform/push.js';
import { NewsService } from './platform/news.js';

/** Builds the configured app; shared by the long-running server (main.ts) and the Vercel function (vercel.ts). */
export async function createServer(opts: { poolSize?: number } = {}) {
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL, opts.poolSize);
  let mailer: Deps['mailer'] | undefined;

  const deps: Deps = {
    config,
    db,
    verifier: JwtVerifier.remote(config.AUTH_JWKS_URL, config.AUTH_ISSUER, config.AUTH_AUDIENCE),
    storage: new S3Storage(config.S3_BUCKET_ORIGINALS, {
      region: config.S3_REGION, endpoint: config.S3_ENDPOINT, forcePathStyle: config.S3_FORCE_PATH_STYLE,
      accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    }),
    get mailer() {
      if (!mailer) throw new Error('mailer not initialised');
      return mailer;
    },
    billing: config.STRIPE_SECRET_KEY && config.STRIPE_WEBHOOK_SECRET ? new StripePaymentProvider(config.STRIPE_SECRET_KEY, config.STRIPE_WEBHOOK_SECRET) : null,
    ai: new AiRouter(config.ANTHROPIC_API_KEY ? ClaudeProvider.fromApiKey(config.ANTHROPIC_API_KEY) : null, routingFromEnv(process.env), {
      recorder: dbCallRecorder(db, newId),
      onRecordError: (err) => console.warn(JSON.stringify({ level: 'warn', msg: 'could not record an AI call', error: String(err) })),
    }),
    dobKey: Buffer.from(config.DOB_ENCRYPTION_KEY, 'base64'),
    now: () => new Date(),
  };

  const provider = footballProviderFromConfig(config);
  deps.football = provider ? new FootballService(provider, db, deps.now, { warn: (o, m) => console.warn(JSON.stringify({ level: 'warn', msg: m, ...o })) }) : null;
  deps.push = pushSenderFromConfig(config);
  deps.news = config.NEWS === 'on'
    ? new NewsService(db, deps.now, { disabled: new Set(config.NEWS_SOURCES_DISABLED), log: { warn: (o, m) => console.warn(JSON.stringify({ level: 'warn', msg: m, ...o })) } })
    : null;

  const app = await buildApp(deps);
  if (config.MAILER !== 'log') throw new Error('MAILER=ses is not implemented yet');
  mailer = new LogMailer(app.log);
  return { app, db, config };
}
