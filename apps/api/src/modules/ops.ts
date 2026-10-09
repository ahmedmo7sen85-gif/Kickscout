import { sql } from 'kysely';
import { HealthView, ReadyView, SeoProfileView, SitemapView } from '@fp/contracts';
import { route } from '../platform/route.js';
import { notFound } from '../platform/errors.js';
import { mediaUrl } from '../platform/storage.js';
import type { Deps } from '../deps.js';
import { API_VERSION } from '../platform/version.js';
import { discoverablePlayers } from './catalog.js';

/** The newest migration this build needs; /v1/ready reports `pending` until it is applied. */
export const REQUIRED_MIGRATION = '0012_guardian.sql';

const SITEMAP_PROFILES = 5000;
const SITEMAP_VIDEOS = 20000;

/**
 * Players that may appear in a sitemap or carry structured data: the same set anyone can discover
 * (active, public profile, player role, scout discovery on), minus demo accounts and accounts
 * waiting for deletion. A minor is included only while their guardian's public-profile consent stands.
 */
export function indexablePlayers(deps: Deps) {
  return discoverablePlayers(deps, null)
    .innerJoin('age_records', 'age_records.user_id', 'users.id')
    .where('users.is_demo', '=', false)
    .where('users.deletion_requested_at', 'is', null)
    .where((eb) => eb.or([
      eb('age_records.age_band', '=', 'adult'),
      eb(
        eb.selectFrom('consents').select('consents.granted').whereRef('consents.subject_user_id', '=', 'users.id')
          .where('consents.purpose', '=', 'public_profile').orderBy('consents.created_at', 'desc').orderBy('consents.id', 'desc').limit(1),
        '=', true,
      ),
    ]));
}

async function pingDb(deps: Deps): Promise<number | null> {
  const started = performance.now();
  try {
    await sql`SELECT 1`.execute(deps.db);
    return Math.round(performance.now() - started);
  } catch {
    return null;
  }
}

export const opsRoutes = [
  route(
    { method: 'get', path: '/v1/health', summary: 'Liveness with a database ping (503 when the database is unreachable)', tag: 'ops', auth: 'none', response: HealthView },
    async (ctx) => {
      const ms = await pingDb(ctx.deps);
      if (ms === null) ctx.setStatus(503);
      return { status: ms === null ? 'degraded' as const : 'ok' as const, version: API_VERSION, checks: { database: ms === null ? 'down' as const : 'ok' as const }, databaseLatencyMs: ms };
    },
  ),
  route(
    { method: 'get', path: '/v1/ready', summary: 'Readiness: database reachable and this build’s migrations applied (503 otherwise)', tag: 'ops', auth: 'none', response: ReadyView },
    async (ctx) => {
      const ms = await pingDb(ctx.deps);
      let migrations: 'ok' | 'pending' | 'unknown' = 'unknown';
      if (ms !== null) {
        try {
          const row = await sql<{ name: string }>`SELECT name FROM schema_migrations WHERE name = ${REQUIRED_MIGRATION}`.execute(ctx.deps.db);
          migrations = row.rows.length ? 'ok' : 'pending';
        } catch {
          migrations = 'unknown';
        }
      }
      const ready = ms !== null && migrations === 'ok';
      if (!ready) ctx.setStatus(503);
      return { ready, checks: { database: ms === null ? 'down' as const : 'ok' as const, migrations } };
    },
  ),

  route(
    { method: 'get', path: '/v1/sitemap', summary: 'Indexable public player profiles and their public published videos (for sitemap.xml)', tag: 'seo', auth: 'none', response: SitemapView },
    async (ctx) => {
      const players = await indexablePlayers(ctx.deps)
        .select(['users.id', 'profiles.handle', 'profiles.updated_at']).orderBy('profiles.updated_at', 'desc').limit(SITEMAP_PROFILES).execute();
      const videos = await ctx.deps.db.selectFrom('videos')
        .select(['videos.id', 'videos.published_at', 'videos.created_at'])
        .where('videos.status', '=', 'published').where('videos.visibility', '=', 'public').where('videos.deleted_at', 'is', null)
        .where('videos.owner_user_id', 'in', indexablePlayers(ctx.deps).select('users.id'))
        .orderBy('videos.published_at', 'desc').limit(SITEMAP_VIDEOS).execute();
      return {
        profiles: players.map((p) => ({ handle: p.handle, updatedAt: p.updated_at.toISOString() })),
        videos: videos.map((v) => ({ id: v.id, updatedAt: (v.published_at ?? v.created_at).toISOString() })),
      };
    },
  ),
  route(
    { method: 'get', path: '/v1/seo/profiles/:handle', summary: 'Public facts for a profile’s page metadata and structured data; 404 unless the profile is indexable', tag: 'seo', auth: 'none', response: SeoProfileView },
    async (ctx) => {
      const handle = ctx.params.handle ?? '';
      if (!/^[a-zA-Z0-9_.]{3,30}$/.test(handle)) throw notFound('profile');
      const row = await indexablePlayers(ctx.deps)
        .select(['profiles.handle', 'profiles.display_name', 'profiles.bio', 'profiles.avatar_key', 'profiles.verified_at', 'profiles.updated_at', 'player_profiles.primary_position'])
        .where('profiles.handle', '=', handle).executeTakeFirst();
      if (!row) throw notFound('profile');
      return {
        handle: row.handle, displayName: row.display_name, bio: row.bio, avatarUrl: row.avatar_key ? mediaUrl(ctx.deps.config.CDN_BASE_URL, row.avatar_key) : null,
        position: row.primary_position ?? null, verified: row.verified_at !== null, updatedAt: row.updated_at.toISOString(),
      };
    },
  ),
];
