import { ChallengeList, ChallengeView, CursorQuery, EnterChallengeRequest, VideoPage } from '@fp/contracts';
import type { z } from 'zod';
import type { Deps } from '../deps.js';
import { route } from '../platform/route.js';
import { ApiError, conflict, notFound } from '../platform/errors.js';
import { discoverable, pageOfVideos, videoQuery } from './media.js';

function challengeQuery(deps: Deps) {
  return deps.db.selectFrom('challenges').select((eb) => [
    'challenges.id', 'challenges.slug', 'challenges.title', 'challenges.description', 'challenges.skill_key', 'challenges.hashtag',
    'challenges.starts_at', 'challenges.ends_at', 'challenges.is_demo',
    eb.selectFrom('challenge_entries').innerJoin('videos', 'videos.id', 'challenge_entries.video_id')
      .select(eb.fn.countAll<string>().as('n')).whereRef('challenge_entries.challenge_id', '=', 'challenges.id')
      .where('videos.status', '=', 'published').as('entries'),
  ]);
}

export async function challengeViews(deps: Deps, filter: (q: ReturnType<typeof challengeQuery>) => ReturnType<typeof challengeQuery>): Promise<z.input<typeof ChallengeView>[]> {
  const now = deps.now();
  const rows = await filter(challengeQuery(deps)).execute();
  return rows.map((r) => ({
    id: r.id, slug: r.slug, title: r.title as never, description: r.description as never, skill: r.skill_key as never, hashtag: r.hashtag,
    startsAt: r.starts_at.toISOString(), endsAt: r.ends_at.toISOString(),
    state: r.starts_at > now ? 'upcoming' : r.ends_at < now ? 'ended' : 'active',
    entries: Number(r.entries ?? 0), isDemo: r.is_demo,
  }));
}

async function bySlug(deps: Deps, slug: string) {
  const c = (await challengeViews(deps, (q) => q.where('challenges.slug', '=', slug)))[0];
  if (!c) throw notFound('challenge');
  return c;
}

export const challengeRoutes = [
  route(
    { method: 'get', path: '/v1/challenges', summary: 'Active and upcoming challenges, then recent ones', tag: 'challenges', auth: 'optional', response: ChallengeList },
    async (ctx) => {
      const items = await challengeViews(ctx.deps, (q) => q.orderBy('challenges.ends_at', 'desc').limit(50));
      const rank = { active: 0, upcoming: 1, ended: 2 } as const;
      return { items: items.sort((a, b) => rank[a.state] - rank[b.state]) };
    },
  ),
  route(
    { method: 'get', path: '/v1/challenges/:slug', summary: 'A challenge', tag: 'challenges', auth: 'optional', response: ChallengeView },
    async (ctx) => bySlug(ctx.deps, ctx.params.slug!),
  ),
  route(
    { method: 'get', path: '/v1/challenges/:slug/entries', summary: 'Published entries to a challenge', tag: 'challenges', auth: 'optional', query: CursorQuery, response: VideoPage },
    async (ctx) => {
      const c = await bySlug(ctx.deps, ctx.params.slug!);
      const q = discoverable(videoQuery(ctx.deps.db), ctx.actor)
        .where('videos.id', 'in', (eb) => eb.selectFrom('challenge_entries').select('video_id').where('challenge_id', '=', c.id));
      return pageOfVideos(ctx.deps, ctx.actor, q, ctx.query);
    },
  ),
  route(
    { method: 'post', path: '/v1/challenges/:slug/entries', summary: 'Enter one of your videos into a challenge', tag: 'challenges', auth: 'user', body: EnterChallengeRequest, status: 204 },
    async (ctx) => {
      const c = await bySlug(ctx.deps, ctx.params.slug!);
      if (c.state !== 'active') throw new ApiError(400, 'CHALLENGE_NOT_OPEN', 'this challenge is not open');
      const v = await ctx.deps.db.selectFrom('videos').select(['id', 'owner_user_id']).where('id', '=', ctx.body.videoId).where('status', '!=', 'deleted').executeTakeFirst();
      if (!v) throw notFound('video');
      ctx.authorize({ kind: 'challenge.enter', videoOwnerId: v.owner_user_id });
      const res = await ctx.deps.db.insertInto('challenge_entries').values({ challenge_id: c.id, video_id: v.id })
        .onConflict((oc) => oc.columns(['challenge_id', 'video_id']).doNothing()).returning('video_id').executeTakeFirst();
      if (!res) throw conflict('ALREADY_ENTERED', 'this video is already entered');
    },
  ),
];
