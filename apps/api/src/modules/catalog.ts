import { sql } from 'kysely';
import type { z } from 'zod';
import { CursorQuery, DiscoverView, RadarPage, RadarQuery, SearchQuery, SearchResult, SkillList, VideoPage } from '@fp/contracts';
import { capability, describeReason, rankRadar } from '@fp/domain';
import type { Actor, RadarStats } from '@fp/domain';
import type { Deps } from '../deps.js';
import { route } from '../platform/route.js';
import { notFound } from '../platform/errors.js';
import { discoverable, pageOfVideos, toVideoViews, videoQuery } from './media.js';
import { playerCards, relationTo } from './views.js';
import { challengeViews, listable } from './challenge-views.js';

const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export const RADAR_DISCLAIMER = {
  en: 'Talent Radar shows players getting attention right now, based on likes, views and followers. It is not a judgment of ability or potential.',
  ar: 'يعرض رادار المواهب اللاعبين الذين يلفتون الانتباه الآن بناءً على الإعجابات والمشاهدات والمتابعين. وهو ليس حكمًا على المهارة أو الإمكانات.',
};

/**
 * Players anyone may discover: active, public profile, player role, scout discovery allowed, not
 * blocked either way. Every player listing (search, Discover, Talent Radar, scout search and the
 * scout actions) starts here, so unlisted, private and discovery-off players never appear in one.
 * Signed-out visitors cannot be told apart from scouts, so discovery-off applies to everyone.
 */
export function discoverablePlayers(deps: Deps, viewer: Actor | null) {
  let q = deps.db.selectFrom('users')
    .innerJoin('profiles', 'profiles.user_id', 'users.id')
    .innerJoin('privacy_settings', 'privacy_settings.user_id', 'users.id')
    .innerJoin('user_roles', (j) => j.onRef('user_roles.user_id', '=', 'users.id').on('user_roles.role', '=', 'player'))
    .leftJoin('player_profiles', 'player_profiles.user_id', 'users.id')
    .leftJoin('regions', 'regions.id', 'profiles.region_id')
    .where('users.status', '=', 'active')
    .where('privacy_settings.profile_visibility', '=', 'public')
    .where('privacy_settings.allow_scout_discovery', '=', true);
  if (viewer) {
    const me = viewer.userId;
    q = q.where(({ not, exists, selectFrom, or, and }) => not(exists(selectFrom('blocks').select('blocker_id').where((b) => or([
      and([b('blocks.blocker_id', '=', me), b('blocks.blocked_id', '=', b.ref('users.id'))]),
      and([b('blocks.blocked_id', '=', me), b('blocks.blocker_id', '=', b.ref('users.id'))]),
    ])))));
  }
  return q;
}
type PlayerQuery = ReturnType<typeof discoverablePlayers>;

export function filterPlayers(q: PlayerQuery, f: { q?: string; country?: string; position?: string; foot?: string; skill?: string }) {
  if (f.q) q = q.where((eb) => eb.or([eb('profiles.handle', 'ilike', likePattern(f.q!)), eb('profiles.display_name', 'ilike', likePattern(f.q!))]));
  // Country is only searchable where the player shows it.
  if (f.country) {
    q = q.where('regions.country_code', '=', f.country).where('privacy_settings.region_precision', '!=', 'macro')
      .where('privacy_settings.show_country', '=', true);
  }
  if (f.position) q = q.where('player_profiles.primary_position', '=', f.position);
  if (f.foot) q = q.where('player_profiles.preferred_foot', '=', f.foot);
  if (f.skill) {
    q = q.where(({ exists, selectFrom }) => exists(selectFrom('video_skills').innerJoin('videos', 'videos.id', 'video_skills.video_id')
      .select('video_skills.video_id').whereRef('videos.owner_user_id', '=', 'users.id').where('videos.status', '=', 'published')
      .where('video_skills.status', '=', 'active').where('video_skills.skill_key', '=', f.skill!)));
  }
  return q;
}

async function skillNames(deps: Deps) {
  const rows = await deps.db.selectFrom('skills').select(['key', 'names']).execute();
  const map = new Map(rows.map((r) => [r.key, r.names as { en: string; ar: string }]));
  return (key: string) => map.get(key) ?? { en: key, ar: key };
}

/** Engagement stats for Talent Radar, for players with any activity in the last two weeks. */
async function radarStats(deps: Deps, viewer: Actor | null, f: z.output<typeof RadarQuery>): Promise<RadarStats[]> {
  const candidates = filterPlayers(discoverablePlayers(deps, viewer), f).select('users.id');
  const rows = await sql<{
    id: string; likes7d: string; likes_prev: string; views7d: string; views_prev: string; new_followers: string; followers: string;
    age_days: number; entries7d: string; saves7d: string; top_skill: string | null; top_skill_videos: string | null; country: string | null;
  }>`
    WITH c AS (${candidates}),
    pv AS (SELECT v.id, v.owner_user_id FROM videos v JOIN c ON c.id = v.owner_user_id
           WHERE v.status = 'published' AND v.visibility = 'public'),
    top AS (SELECT DISTINCT ON (pv.owner_user_id) pv.owner_user_id, vs.skill_key, count(DISTINCT vs.video_id) AS n
            FROM pv JOIN video_skills vs ON vs.video_id = pv.id AND vs.status = 'active'
            JOIN videos v ON v.id = pv.id AND v.published_at > now() - interval '30 days'
            GROUP BY pv.owner_user_id, vs.skill_key ORDER BY pv.owner_user_id, n DESC, vs.skill_key)
    SELECT c.id,
      (SELECT count(*) FROM likes l JOIN pv ON pv.id = l.video_id WHERE pv.owner_user_id = c.id AND l.created_at > now() - interval '7 days') AS likes7d,
      (SELECT count(*) FROM likes l JOIN pv ON pv.id = l.video_id WHERE pv.owner_user_id = c.id AND l.created_at <= now() - interval '7 days' AND l.created_at > now() - interval '14 days') AS likes_prev,
      (SELECT count(*) FROM video_views w JOIN pv ON pv.id = w.video_id WHERE pv.owner_user_id = c.id AND w.day > current_date - 7) AS views7d,
      (SELECT count(*) FROM video_views w JOIN pv ON pv.id = w.video_id WHERE pv.owner_user_id = c.id AND w.day <= current_date - 7 AND w.day > current_date - 14) AS views_prev,
      (SELECT count(*) FROM follows f WHERE f.followee_id = c.id AND f.created_at > now() - interval '7 days') AS new_followers,
      (SELECT count(*) FROM follows f WHERE f.followee_id = c.id) AS followers,
      (SELECT extract(day FROM now() - u.created_at)::int FROM users u WHERE u.id = c.id) AS age_days,
      (SELECT count(*) FROM saves sv JOIN pv ON pv.id = sv.video_id WHERE pv.owner_user_id = c.id AND sv.created_at > now() - interval '7 days') AS saves7d,
      (SELECT count(*) FROM challenge_entries ce JOIN pv ON pv.id = ce.video_id WHERE pv.owner_user_id = c.id AND ce.created_at > now() - interval '7 days') AS entries7d,
      top.skill_key AS top_skill, top.n AS top_skill_videos,
      -- Country only where the player shows it (regional standouts never reveal a hidden country).
      (SELECT CASE WHEN ps.show_country AND ps.region_precision <> 'macro' THEN r.country_code END
         FROM profiles p JOIN privacy_settings ps ON ps.user_id = p.user_id LEFT JOIN regions r ON r.id = p.region_id
        WHERE p.user_id = c.id) AS country
    FROM c LEFT JOIN top ON top.owner_user_id = c.id
    WHERE EXISTS (SELECT 1 FROM pv WHERE pv.owner_user_id = c.id)
  `.execute(deps.db);
  return rows.rows.map((r) => ({
    playerId: r.id, likes7d: Number(r.likes7d), likesPrev7d: Number(r.likes_prev), views7d: Number(r.views7d), viewsPrev7d: Number(r.views_prev),
    newFollowers7d: Number(r.new_followers), followers: Number(r.followers), accountAgeDays: r.age_days, challengeEntries7d: Number(r.entries7d), saves7d: Number(r.saves7d),
    topSkill: r.top_skill ? { key: r.top_skill, videos: Number(r.top_skill_videos) } : null,
    country: r.country?.trim() ?? null,
  }));
}

async function radar(deps: Deps, viewer: Actor | null, f: z.output<typeof RadarQuery>) {
  const [stats, names] = await Promise.all([radarStats(deps, viewer, f), skillNames(deps)]);
  const ranked = rankRadar(stats, f.limit, f.category);
  const cards = new Map((await playerCards(deps, viewer, ranked.map((e) => e.playerId))).map((c) => [c.userId, c]));
  return ranked.flatMap((e) => {
    const player = cards.get(e.playerId);
    return player ? [{ player, reasons: e.reasons.map((r) => ({ code: r.code, text: describeReason(r, names) })) }] : [];
  });
}

export const catalogRoutes = [
  route(
    { method: 'get', path: '/v1/skills', summary: 'The skill taxonomy', tag: 'discovery', auth: 'none', response: SkillList },
    async (ctx) => {
      const rows = await ctx.deps.db.selectFrom('skills').selectAll().orderBy('sort_order').execute();
      return { items: rows.map((r) => ({ key: r.key as never, category: r.category, name: r.names as never })) };
    },
  ),

  route(
    { method: 'get', path: '/v1/search', summary: 'Search players, videos and hashtags', tag: 'discovery', auth: 'optional', query: SearchQuery, response: SearchResult, rateLimit: { max: 60, timeWindow: '1 minute' } },
    async (ctx) => {
      const f = ctx.query;
      const viewer = ctx.actor;
      const want = (t: 'players' | 'videos' | 'hashtags') => f.type === 'all' || f.type === t;
      const limit = f.type === 'all' ? Math.min(f.limit, 10) : f.limit;
      const hashtag = f.hashtag?.replace(/^#+/, '').toLowerCase();

      const players = want('players') && !hashtag
        ? await filterPlayers(discoverablePlayers(ctx.deps, viewer), f).select('users.id').orderBy('profiles.handle').limit(limit).execute()
        : [];

      let vq = discoverable(videoQuery(ctx.deps.db), viewer);
      if (f.q) {
        const q = f.q;
        vq = vq.where((eb) => eb.or([
          eb('videos.title', 'ilike', likePattern(q)),
          sql<boolean>`to_tsvector('simple', videos.title || ' ' || coalesce(videos.description, '')) @@ plainto_tsquery('simple', ${q})`,
          eb('profiles.handle', 'ilike', likePattern(q)),
        ]));
      }
      if (f.skill) {
        vq = vq.where(({ exists, selectFrom }) => exists(selectFrom('video_skills').select('video_id').whereRef('video_skills.video_id', '=', 'videos.id')
          .where('video_skills.skill_key', '=', f.skill!).where('video_skills.status', '=', 'active')));
      }
      if (hashtag) vq = vq.where('videos.id', 'in', (eb) => eb.selectFrom('video_hashtags').select('video_id').where('tag', '=', hashtag));
      if (f.position) vq = vq.where('videos.position', '=', f.position);
      if (f.foot) vq = vq.where('videos.foot', '=', f.foot);
      if (f.country) {
        vq = vq.where('regions.country_code', '=', f.country).where('privacy_settings.region_precision', '!=', 'macro')
          .where('privacy_settings.show_country', '=', true);
      }
      const videoRows = want('videos') ? await vq.orderBy('videos.published_at', 'desc').limit(limit).execute() : [];

      const tags = want('hashtags') && (f.q || hashtag)
        ? await ctx.deps.db.selectFrom('video_hashtags').innerJoin('videos', 'videos.id', 'video_hashtags.video_id')
          .select(['video_hashtags.tag', ctx.deps.db.fn.countAll<string>().as('n')])
          .where('videos.status', '=', 'published').where('videos.visibility', '=', 'public')
          .where('video_hashtags.tag', 'like', `${(hashtag ?? f.q!).replace(/^#+/, '').toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
          .groupBy('video_hashtags.tag').orderBy('n', 'desc').limit(limit).execute()
        : [];

      return {
        players: await playerCards(ctx.deps, viewer, players.map((p) => p.id)),
        videos: await toVideoViews(ctx.deps, viewer, videoRows),
        hashtags: tags.map((t) => ({ tag: t.tag, videos: Number(t.n) })),
      };
    },
  ),

  route(
    { method: 'get', path: '/v1/radar', summary: 'Talent Radar: players gaining attention, with the reasons', tag: 'discovery', auth: 'optional', query: RadarQuery, response: RadarPage },
    async (ctx) => ({
      category: ctx.query.category,
      capability: capability('talent_radar'),
      disclaimer: RADAR_DISCLAIMER,
      items: await radar(ctx.deps, ctx.actor, ctx.query),
    }),
  ),

  route(
    { method: 'get', path: '/v1/discover', summary: 'Discover page: skills, hashtags, challenges, rising players, latest', tag: 'discovery', auth: 'optional', response: DiscoverView },
    async (ctx) => {
      const db = ctx.deps.db;
      const viewer = ctx.actor;
      const [skills, hashtags, challenges, rising, latest] = await Promise.all([
        db.selectFrom('skills').select((eb) => ['skills.key', 'skills.category', 'skills.names',
          eb.selectFrom('video_skills').innerJoin('videos', 'videos.id', 'video_skills.video_id').select(sql<string>`count(DISTINCT video_skills.video_id)`.as('n'))
            .whereRef('video_skills.skill_key', '=', 'skills.key').where('video_skills.status', '=', 'active')
            .where('videos.status', '=', 'published').where('videos.visibility', '=', 'public').as('videos')]).orderBy('sort_order').execute(),
        db.selectFrom('video_hashtags').innerJoin('videos', 'videos.id', 'video_hashtags.video_id')
          .select(['video_hashtags.tag', db.fn.countAll<string>().as('n')])
          .where('videos.status', '=', 'published').where('videos.visibility', '=', 'public')
          .where('videos.published_at', '>', sql<Date>`now() - interval '7 days'`)
          .groupBy('video_hashtags.tag').orderBy('n', 'desc').limit(12).execute(),
        challengeViews(ctx.deps, (q) => listable(q).where('challenges.ends_at', '>', ctx.deps.now()).orderBy('challenges.starts_at').limit(6)),
        radar(ctx.deps, viewer, { limit: 6, category: 'rising' }),
        discoverable(videoQuery(db), viewer).orderBy('videos.published_at', 'desc').limit(12).execute(),
      ]);
      return {
        skills: skills.map((s) => ({ key: s.key as never, category: s.category, name: s.names as never, videos: Number(s.videos ?? 0) })),
        trendingHashtags: hashtags.map((h) => ({ tag: h.tag, videos: Number(h.n) })),
        challenges,
        risingPlayers: rising.map((r) => r.player),
        latest: await toVideoViews(ctx.deps, viewer, latest),
      };
    },
  ),

  route(
    { method: 'get', path: '/v1/profiles/:handle/videos', summary: 'A player’s published videos', tag: 'profiles', auth: 'optional', query: CursorQuery, response: VideoPage },
    async (ctx) => {
      const owner = await ctx.deps.db.selectFrom('profiles').select('user_id').where('handle', '=', ctx.params.handle!).executeTakeFirst();
      if (!owner) throw notFound('profile');
      const relation = await relationTo(ctx.deps.db, ctx.actor, owner.user_id);
      let q = videoQuery(ctx.deps.db).where('videos.owner_user_id', '=', owner.user_id).where('videos.status', '=', 'published').where('users.status', '=', 'active');
      if (relation === 'self' || relation === 'guardian' || relation === 'admin' || relation === 'moderator') {
        // full list
      } else if (relation === 'follower') {
        q = q.where('videos.visibility', 'in', ['public', 'followers']).where('privacy_settings.profile_visibility', '!=', 'private');
      } else {
        // The profile page is a direct link, so an unlisted player's public clips show here and nowhere else.
        q = discoverable(q, ctx.actor, { includeUnlisted: true });
      }
      return pageOfVideos(ctx.deps, ctx.actor, q, ctx.query);
    },
  ),
];
