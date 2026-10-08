import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDb } from '@fp/db';
import type { Database } from '@fp/db';
import { migrate } from '@fp/db';
import { JwtVerifier } from '../src/platform/auth.js';
import type { ObjectStorage } from '../src/platform/storage.js';
import type { Mailer } from '../src/platform/mailer.js';
import type { Config } from '../src/config.js';
import type { Deps } from '../src/deps.js';

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://fp:fp@localhost:5432/postgres';
const ISSUER = 'https://idp.test/';
const AUDIENCE = 'authenticated';

/** Test double for object storage: records presigned uploads and lets a test "upload" a file. */
export class MemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, { sizeBytes: number; contentType: string | null }>();
  async presignPut(key: string, contentType: string) {
    return { url: `https://storage.test/${key}`, headers: { 'content-type': contentType }, expiresAt: new Date(Date.now() + 900_000) };
  }
  async head(key: string) {
    return this.objects.get(key) ?? null;
  }
}

export class RecordingMailer implements Mailer {
  readonly invitations: { to: string; token: string }[] = [];
  async sendGuardianInvitation(to: string, _name: string, token: string) {
    this.invitations.push({ to, token });
  }
  readonly orgInvitations: { to: string; organization: string; role: string; token: string }[] = [];
  async sendOrganizationInvitation(to: string, organization: string, role: string, token: string) {
    this.orgInvitations.push({ to, organization, role, token });
  }
}

export interface TestEnv {
  app: FastifyInstance;
  deps: Deps;
  db: Database;
  storage: MemoryStorage;
  mailer: RecordingMailer;
  token(sub: string, claims?: { email?: string; email_verified?: boolean; amr?: unknown[]; aal?: string }): Promise<string>;
  close(): Promise<void>;
}

export async function createTestEnv(overrides: Partial<Config> = {}): Promise<TestEnv> {
  const dbName = `fp_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  await migrate(url.toString());
  process.env.__TEST_DB_URL__ = url.toString();

  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' };
  const verifier = new JwtVerifier(createLocalJWKSet({ keys: [jwk] }), ISSUER, AUDIENCE);

  const db = createDb(url.toString(), 5);
  const storage = new MemoryStorage();
  const mailer = new RecordingMailer();
  const config = {
    NODE_ENV: 'test', PORT: 0, DATABASE_URL: url.toString(), AUTH_JWKS_URL: 'https://idp.test/jwks', AUTH_ISSUER: ISSUER,
    AUTH_AUDIENCE: AUDIENCE, S3_REGION: 'eu-central-1', S3_BUCKET_ORIGINALS: 'test', S3_FORCE_PATH_STYLE: true, CDN_BASE_URL: 'https://cdn.test',
    DOB_ENCRYPTION_KEY: randomBytes(32).toString('base64'), VIEWER_HASH_SECRET: randomBytes(32).toString('hex'), MAILER: 'log', ALLOW_LOG_MAILER: 'no', RATE_LIMIT_STORE: 'memory', MAX_VIDEO_SECONDS: 60, MAX_ACTIVE_VIDEOS: 20, MAX_UPLOADS_PER_DAY: 10, POLICY_VERSION: 'test-1',
    CORS_ORIGINS: 'https://web.test',
  } satisfies Config;
  Object.assign(config, overrides);
  const deps: Deps = { config, db, verifier, storage, mailer, dobKey: Buffer.from(config.DOB_ENCRYPTION_KEY, 'base64'), now: () => new Date() };
  const app = await buildApp(deps, { logger: false });

  return {
    app, deps, db, storage, mailer,
    token: (sub, claims = {}) =>
      new SignJWT({ ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setSubject(sub).setIssuer(ISSUER)
        .setAudience(AUDIENCE).setIssuedAt().setExpirationTime('10m').sign(privateKey),
    async close() {
      await app.close();
      await db.destroy();
      await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
      await admin.end();
    },
  };
}
