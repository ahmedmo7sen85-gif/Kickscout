import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDb } from '../src/db/db.js';
import type { Database } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { JwtVerifier } from '../src/platform/auth.js';
import type { ObjectStorage } from '../src/platform/storage.js';
import type { Mailer } from '../src/platform/mailer.js';
import type { Config } from '../src/config.js';
import type { Deps } from '../src/deps.js';

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://fp:fp@localhost:5432/postgres';
const ISSUER = 'https://idp.test/';
const AUDIENCE = 'football-api';
export const SERVICE_TOKEN = randomBytes(32).toString('hex');

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
}

export interface TestEnv {
  app: FastifyInstance;
  db: Database;
  storage: MemoryStorage;
  mailer: RecordingMailer;
  token(sub: string, claims?: { email?: string; email_verified?: boolean; amr?: string[] }): Promise<string>;
  close(): Promise<void>;
}

export async function createTestEnv(): Promise<TestEnv> {
  const dbName = `fp_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  await migrate(url.toString());

  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' };
  const verifier = new JwtVerifier(createLocalJWKSet({ keys: [jwk] }), ISSUER, AUDIENCE);

  const db = createDb(url.toString(), 5);
  const storage = new MemoryStorage();
  const mailer = new RecordingMailer();
  const config = {
    NODE_ENV: 'test', PORT: 0, DATABASE_URL: url.toString(), AUTH_JWKS_URL: 'https://idp.test/jwks', AUTH_ISSUER: ISSUER,
    AUTH_AUDIENCE: AUDIENCE, S3_REGION: 'eu-central-1', S3_BUCKET_ORIGINALS: 'test', CDN_BASE_URL: 'https://cdn.test',
    DOB_ENCRYPTION_KEY: randomBytes(32).toString('base64'), INTERNAL_SERVICE_TOKEN: SERVICE_TOKEN, MAILER: 'log', POLICY_VERSION: 'test-1',
  } satisfies Config;
  const deps: Deps = { config, db, verifier, storage, mailer, dobKey: Buffer.from(config.DOB_ENCRYPTION_KEY, 'base64'), now: () => new Date() };
  const app = await buildApp(deps, { logger: false });

  return {
    app, db, storage, mailer,
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
