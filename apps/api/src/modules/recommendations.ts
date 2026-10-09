import { z } from 'zod';
import { sql } from 'kysely';
import type { Transaction } from 'kysely';
import { RecommendationSettingsView, UpdateRecommendationSettingsRequest } from '@fp/contracts';
import { describeForYouReason, NEWEST_REASON, rankForYou } from '@fp/domain';
import type { Actor, ForYouCandidate, ForYouSignals } from '@fp/domain';
import type { DB } from '@fp/db';
import type { Deps } from '../deps.js';
import { route } from '../platform/route.js';
import { isEnabled } from '../platform/flags.js';
import { notFound } from '../platform/errors.js';
import { discoverable, toVideoViews, videoQuery } from './media.js';
import type { VideoRow } from './media.js';

const Uuid = z.uuid();

/** How far back For You looks for clips, and how many it ranks. */
const CANDIDATE_DAYS = 60;
const CANDIDATE_LIMIT = 500;
/** Likes and saves older than this stop shaping the feed even without a reset. */
const SIGNAL_DAYS = 180;
const MAX_OFFSET = 1000;

/**
 * Personalisation is on for this viewer when FOR_YOU_PERSONALIZATION=on (everyone) or the
 * `for_you_personalization` flag includes them (gradual rollout from the admin flags page).
 */
export async function personalizationAvailable(deps: Deps, viewer: Actor | null): Promise<boolean> {
  return deps.config.FOR_YOU_PERSONALIZATION === 'on' || (await isEnabled(deps, 'for_you_personalization', viewer));
}

export async function recommendationPrefs(deps: Deps, userId: string) {
  const row = await deps.db.selectFrom('recommendation_preferences').selectAll().where('user_id', '=', userId).executeTakeFirst();
  return { personalize: row?.personalize ?? true, historyResetAt: row?.history_reset_at ?? null };
}

async function notInterested(deps: Deps, userId: string) {
  const rows = await deps.db.selectFrom('recommendation_signals').select(['target_kind', 'target_id', 'created_at'])
    .where('user_id', '=', userId).where('kind', '=', 'not_interested').orderBy('created_at').execute();
  const of = (k: string) => new Set(rows.filter((r) => r.target_kind === k).map((r) => r.target_id));
  return { rows, videos: of('video'), players: of('player'), skills: of('skill') };
}

async function skillNames(deps: Deps) {
  const rows = await deps.db.selectFrom('skills').select(['key', 'names']).execute();
  const map = new Map(rows.map((r) => [r.key, r.names as { en: string; ar: string }]));
  return (key: string) => map.get(key) ?? { en: key, ar: key };
}

/** Newest-first For You (personalisation off): every item still says why it is there. */
export function plainWhy(items: { id: string }[]) {
  const text = describeForYouReason(NEWEST_REASON, (k) => ({ en: k, ar: k }));
  return Object.fromEntries(items.map((v) => [v.id, { code: NEWEST_REASON.code, text }]));
}

/**
 * The personalised For You page: candidate clips (discoverable, recent, not the viewer's own, not
 * marked "Not interested"), the viewer's own signals, the transparent ranking from @fp/domain, and a
 * reason per item. Offset paging, like Trending, because the order is computed.
 */
export async function personalizedForYou(deps: Deps, viewer: Actor, page: { limit: number; cursor?: string | undefined }, decodeOffset: (c?: string) => number) {
  const offset = decodeOffset(page.cursor);
  const db = deps.db;
  const me = viewer.userId;
  const prefs = await recommendationPrefs(deps, me);
  const hidden = await notInterested(deps, me);
  const signalsSince = new Date(Math.max(deps.now().getTime() - SIGNAL_DAYS * 86_400_000, prefs.historyResetAt?.getTime() ?? 0));

  let cq = discoverable(videoQuery(db), viewer)
    .where('videos.owner_user_id', '!=', me)
    .where('videos.published_at', '>', sql<Date>`now() - make_interval(days => ${CANDIDATE_DAYS})`);
  if (hidden.videos.size) cq = cq.where('videos.id', 'not in', [...hidden.videos].filter((id) => Uuid.safeParse(id).success));
  const rows = await cq.orderBy('videos.published_at', 'desc').orderBy('videos.id', 'desc').limit(CANDIDATE_LIMIT).execute();
  const ids = rows.map((r) => r.id);

  // The viewer's own signals: who they follow, and the skills and positions of clips they liked or saved.
  const engaged = sql<string>`(SELECT video_id FROM likes WHERE user_id = ${me} AND created_at > ${signalsSince}
                               UNION SELECT video_id FROM saves WHERE user_id = ${me} AND created_at > ${signalsSince})`;
  const [tags, followed, likedSkills, likedPositions, viewerRegion] = await Promise.all([
    ids.length ? db.selectFrom('video_skills').select(['video_id', 'skill_key']).where('video_id', 'in', ids).where('status', '=', 'active').execute() : Promise.resolve([]),
    db.selectFrom('follows').select('followee_id').where('follower_id', '=', me).execute(),
    sql<{ skill: string; n: string }>`
      SELECT skill, count(DISTINCT video_id) AS n FROM (
        SELECT vs.video_id, vs.skill_key AS skill FROM video_skills vs WHERE vs.status = 'active' AND vs.video_id IN ${engaged}
        UNION SELECT v.id, v.skill_key FROM videos v WHERE v.skill_key IS NOT NULL AND v.id IN ${engaged}
      ) s GROUP BY skill`.execute(db),
    sql<{ position: string; n: string }>`
      SELECT v.position, count(*) AS n FROM videos v WHERE v.position IS NOT NULL AND v.id IN ${engaged} GROUP BY v.position`.execute(db),
    db.selectFrom('profiles').leftJoin('regions', 'regions.id', 'profiles.region_id').select('regions.country_code').where('profiles.user_id', '=', me).executeTakeFirst(),
  ]);

  const candidates: ForYouCandidate[] = rows.map((r) => ({
    videoId: r.id,
    ownerId: r.owner_user_id,
    ownerHandle: r.handle,
    skills: [...tags.filter((t) => t.video_id === r.id).map((t) => t.skill_key), ...(r.skill_key ? [r.skill_key] : [])],
    position: r.position,
    country: r.region_precision === 'macro' || !r.show_country ? null : r.country_code,
    publishedAt: r.published_at ?? r.created_at,
  }));
  const signals: ForYouSignals = {
    followed: new Set(followed.map((f) => f.followee_id)),
    likedSkills: new Map(likedSkills.rows.map((r) => [r.skill, Number(r.n)])),
    likedPositions: new Map(likedPositions.rows.map((r) => [r.position, Number(r.n)])),
    viewerCountry: viewerRegion?.country_code ?? null,
    notInterested: { videos: hidden.videos, players: hidden.players, skills: hidden.skills },
  };
  const ranked = rankForYou(candidates, signals, deps.now());
  const slice = ranked.slice(offset, offset + page.limit);
  const byId = new Map<string, VideoRow>(rows.map((r) => [r.id, r]));
  const names = await skillNames(deps);
  return {
    items: await toVideoViews(deps, viewer, slice.map((x) => byId.get(x.videoId)!)),
    nextCursor: ranked.length > offset + page.limit && offset + page.limit <= MAX_OFFSET ? Buffer.from(String(offset + page.limit)).toString('base64url') : null,
    why: Object.fromEntries(slice.map((x) => [x.videoId, { code: x.reason.code, text: describeForYouReason(x.reason, names) }])),
  };
}

async function settingsView(deps: Deps, viewer: Actor): Promise<z.input<typeof RecommendationSettingsView>> {
  const [prefs, hidden] = await Promise.all([recommendationPrefs(deps, viewer.userId), notInterested(deps, viewer.userId)]);
  return {
    personalize: prefs.personalize,
    available: await personalizationAvailable(deps, viewer),
    historyResetAt: prefs.historyResetAt?.toISOString() ?? null,
    notInterested: { videos: hidden.videos.size, players: hidden.players.size, skills: [...hidden.skills] as never },
  };
}

/** Used by account deletion: preferences and signals go with the account. */
export async function eraseRecommendationData(tx: Transaction<DB>, userId: string) {
  await tx.deleteFrom('recommendation_signals').where('user_id', '=', userId).execute();
  await tx.deleteFrom('recommendation_preferences').where('user_id', '=', userId).execute();
}

/** For the data export. */
export async function recommendationExport(deps: Deps, userId: string) {
  const [prefs, hidden] = await Promise.all([recommendationPrefs(deps, userId), notInterested(deps, userId)]);
  return {
    personalize: prefs.personalize,
    historyResetAt: prefs.historyResetAt?.toISOString() ?? null,
    notInterested: hidden.rows.map((r) => ({ kind: r.target_kind as 'video' | 'player' | 'skill', id: r.target_id, at: r.created_at.toISOString() })),
  };
}

export const recommendationRoutes = [
  route(
    { method: 'get', path: '/v1/me/recommendations', summary: 'My For You settings and "Not interested" signals', tag: 'feed', auth: 'user', response: RecommendationSettingsView },
    async (ctx) => settingsView(ctx.deps, ctx.me()),
  ),
  route(
    { method: 'patch', path: '/v1/me/recommendations', summary: 'Turn For You personalisation on or off', tag: 'feed', auth: 'user', body: UpdateRecommendationSettingsRequest, response: RecommendationSettingsView },
    async (ctx) => {
      const me = ctx.me().userId;
      await ctx.deps.db.insertInto('recommendation_preferences').values({ user_id: me, personalize: ctx.body.personalize })
        .onConflict((oc) => oc.column('user_id').doUpdateSet({ personalize: ctx.body.personalize, updated_at: ctx.deps.now() })).execute();
      return settingsView(ctx.deps, ctx.me());
    },
  ),
  route(
    { method: 'post', path: '/v1/me/recommendations/reset', summary: 'Reset my recommendation history: forget "Not interested" and stop using earlier likes and saves', tag: 'feed', auth: 'user', response: RecommendationSettingsView },
    async (ctx) => {
      const me = ctx.me().userId;
      const now = ctx.deps.now();
      await ctx.deps.db.transaction().execute(async (tx) => {
        await tx.deleteFrom('recommendation_signals').where('user_id', '=', me).execute();
        await tx.insertInto('recommendation_preferences').values({ user_id: me, history_reset_at: now })
          .onConflict((oc) => oc.column('user_id').doUpdateSet({ history_reset_at: now, updated_at: now })).execute();
      });
      return settingsView(ctx.deps, ctx.me());
    },
  ),
  route(
    { method: 'post', path: '/v1/videos/:videoId/not-interested', summary: '"Not interested": hide this clip; its player and skill stop being boosted for me', tag: 'feed', auth: 'user', status: 204, rateLimit: { max: 120, timeWindow: '1 minute' } },
    async (ctx) => {
      const me = ctx.me();
      const id = Uuid.safeParse(ctx.params.videoId);
      if (!id.success) throw notFound('video');
      const v = await discoverable(videoQuery(ctx.deps.db), me).where('videos.id', '=', id.data).executeTakeFirst();
      if (!v) throw notFound('video');
      // The clip's main skill: the uploader's choice, else its most confident active tag.
      const skill = v.skill_key ?? (await ctx.deps.db.selectFrom('video_skills').select('skill_key').where('video_id', '=', v.id).where('status', '=', 'active')
        .orderBy(sql`coalesce(confidence, 1)`, 'desc').orderBy('skill_key').executeTakeFirst())?.skill_key ?? null;
      const values = [
        { user_id: me.userId, target_kind: 'video', target_id: v.id },
        ...(v.owner_user_id !== me.userId ? [{ user_id: me.userId, target_kind: 'player', target_id: v.owner_user_id }] : []),
        ...(skill ? [{ user_id: me.userId, target_kind: 'skill', target_id: skill }] : []),
      ];
      await ctx.deps.db.insertInto('recommendation_signals').values(values).onConflict((oc) => oc.doNothing()).execute();
    },
  ),
];
