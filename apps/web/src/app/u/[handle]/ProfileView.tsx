'use client';

import { useMemo, useState } from 'react';
import { Section } from '@/components/PageHead';
import { Avatar } from '@/components/player/PlayerCard';
import { ScoutActions } from '@/components/player/ScoutActions';
import { DemoBadge, VerifiedBadge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Skeleton, SkeletonGrid } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { FollowButton } from '@/components/video/FollowButton';
import { ReportSheet } from '@/components/video/ReportSheet';
import { SkillChip } from '@/components/video/SkillChip';
import { VideoCard } from '@/components/video/VideoCard';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { countryName, flagEmoji } from '@/lib/format';
import { useAuthedAction } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n/provider';
import { absoluteUrl, shareLink } from '@/lib/share';
import { useApi } from '@/lib/useApi';
import type { SkillKey, VideoView } from '@/lib/types';

/** Skills this player shows most, from the skill they declared and the tags they added (not AI guesses). */
export function featuredSkills(videos: VideoView[], limit = 4): { skill: SkillKey; count: number }[] {
  const counts = new Map<SkillKey, number>();
  for (const v of videos) {
    const keys = new Set<SkillKey>();
    if (v.skill) keys.add(v.skill);
    for (const tag of v.tags) if (tag.source === 'user') keys.add(tag.skill);
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([skill, count]) => ({ skill, count }));
}

export function ProfileView({ handle }: { handle: string }) {
  const { t, locale, formatNumber, pick } = useI18n();
  const { me, status, isScout } = useAuth();
  const toast = useToast();
  const run = useAuthedAction();
  const p = useApi((s) => api.profile(handle, s), [handle, status]);
  const vids = useApi((s) => api.profileVideos(handle, undefined, s), [handle, status]);
  const skills = useApi((s) => api.skills(s), []);
  const [followers, setFollowers] = useState<number | null>(null);
  const [sheet, setSheet] = useState<'scout' | 'report' | null>(null);
  const [blocked, setBlocked] = useState(false);

  const featured = useMemo(() => (vids.status === 'success' ? featuredSkills(vids.data.items) : []), [vids.status, vids.data]);
  const categories = useMemo(() => {
    if (skills.status !== 'success' || !featured.length) return [];
    const byKey = new Map(skills.data.items.map((s) => [s.key, s]));
    const groups = new Map<string, { label: string; skills: SkillKey[] }>();
    for (const f of featured) {
      const s = byKey.get(f.skill);
      if (!s) continue;
      const g = groups.get(s.category) ?? { label: s.category, skills: [] };
      g.skills.push(f.skill);
      groups.set(s.category, g);
    }
    return [...groups.values()];
  }, [skills.status, skills.data, featured]);

  if (p.status === 'loading') {
    return (
      <div className="wrap page" role="status" aria-label={t.common.loading}>
        <div className="row"><Skeleton width="88px" height="88px" radius="50%" /><div className="stack" style={{ flex: 1 }}><Skeleton width="50%" height="2.4rem" /><Skeleton width="30%" /></div></div>
        <SkeletonGrid count={6} label={t.common.loading} />
      </div>
    );
  }
  if (p.status === 'error') {
    return (
      <div className="wrap page">
        {p.error.status === 404 ? <EmptyState icon="user" title={t.profile.notFoundTitle} text={t.profile.notFoundText} action={<ButtonLink href="/discover">{t.nav.discover}</ButtonLink>} />
          : <ErrorState error={p.error} onRetry={p.retry} />}
      </div>
    );
  }

  const prof = p.data;
  const isMe = me?.userId === prof.userId;
  const country = prof.region.country;
  const followerCount = followers ?? prof.stats.followers;
  const challengeVideos = vids.status === 'success' ? vids.data.items.filter((v) => v.context === 'challenge') : [];

  const share = async () => {
    const r = await shareLink(absoluteUrl(`/u/${prof.handle}`), `@${prof.handle} · KICKSCOUT`);
    if (r === 'copied') toast.show(t.common.linkCopied, { tone: 'success' });
    if (r === 'failed') toast.show(t.common.copyFailed, { tone: 'error' });
  };
  const block = async () => { if (await run(() => api.block(prof.userId))) { setBlocked(true); toast.show(t.profile.blocked); } };

  return (
    <div className="wrap page">
      <header className="profile-head">
        <Avatar src={prof.avatarUrl} name={prof.displayName} size={96} />
        <div className="stack stack--tight">
          <h1 className="profile-name">
            <span dir="auto">{prof.displayName}</span>
            {prof.verified ? <VerifiedBadge /> : null}
            {prof.isDemo ? <DemoBadge /> : null}
          </h1>
          <p className="muted">@{prof.handle}</p>
          {prof.isDemo ? <p className="small" style={{ color: 'var(--warn)' }}>{t.profile.demoNote}</p> : null}
          {prof.bio ? <p dir="auto" className="page-intro">{prof.bio}</p> : null}
        </div>
      </header>

      <dl className="facts">
        {prof.player?.primaryPosition ? <><dt>{t.profile.position}</dt><dd>{t.positions[prof.player.primaryPosition]}{prof.player.secondaryPositions.length ? ` · ${prof.player.secondaryPositions.map((x) => t.positions[x]).join(', ')}` : ''}</dd></> : null}
        {country ? <><dt>{t.profile.country}</dt><dd>{flagEmoji(country)} {countryName(country, locale)}</dd></> : null}
        {prof.player?.preferredFoot ? <><dt>{t.profile.foot}</dt><dd>{t.feet[prof.player.preferredFoot]}</dd></> : null}
        {prof.ageGroup ? <><dt>{t.profile.ageGroup}</dt><dd>{t.ageBands[prof.ageGroup]}</dd></> : null}
      </dl>

      <div className="profile-stats" data-testid="profile-stats">
        <div><strong>{formatNumber(followerCount)}</strong><span>{t.profile.followers}</span></div>
        <div><strong>{formatNumber(prof.stats.videos)}</strong><span>{t.profile.videos}</span></div>
        <div><strong>{formatNumber(prof.stats.likes)}</strong><span>{t.profile.likes}</span></div>
      </div>

      <div className="cta-row">
        {isMe ? <ButtonLink href="/settings" variant="secondary">{t.profile.editProfile}</ButtonLink> : (
          <FollowButton userId={prof.userId} initial={prof.followedByMe} size="md" labels={{ follow: t.profile.follow, following: t.profile.unfollow }}
            onChange={(on) => setFollowers(followerCount + (on ? 1 : -1))} />
        )}
        <Button onClick={share}>{t.profile.share}</Button>
        {isScout && !isMe ? <Button variant="primary" onClick={() => setSheet('scout')}>{t.profile.scoutAction}</Button> : null}
        {!isMe ? <Button variant="ghost" onClick={() => setSheet('report')}>{t.profile.report}</Button> : null}
        {!isMe && status === 'signed_in' ? <Button variant="ghost" onClick={block} disabled={blocked}>{blocked ? t.profile.blocked : t.profile.block}</Button> : null}
      </div>
      {isScout && prof.isMinor ? <p className="notice notice--warn small">{t.profile.minorNote}</p> : null}

      <Section title={t.profile.featuredSkills} id="featured">
        {vids.status === 'success' && featured.length
          ? <ul className="chips">{featured.map((f) => <li key={f.skill}><SkillChip skill={f.skill} count={f.count} href={`/search?type=videos&skill=${f.skill}`} /></li>)}</ul>
          : vids.status === 'loading' ? <Skeleton width="60%" height="2rem" /> : <p className="muted small">{t.profile.featuredEmpty}</p>}
      </Section>

      <Section title={t.profile.videosTitle} id="videos">
        {vids.status === 'loading' ? <SkeletonGrid count={6} label={t.common.loading} /> : null}
        {vids.status === 'error' ? <ErrorState error={vids.error} onRetry={vids.retry} /> : null}
        {vids.status === 'success' && vids.data.items.length === 0 ? <EmptyState icon="play" title={t.profile.videosEmpty}
          action={isMe ? <ButtonLink href="/upload" variant="primary">{t.nav.upload}</ButtonLink> : undefined} /> : null}
        {vids.status === 'success' && vids.data.items.length > 0 ? (
          <div className="grid-cards">{vids.data.items.map((v) => <VideoCard key={v.id} video={v} showOwner={false} showStatus={isMe} />)}</div>
        ) : null}
      </Section>

      {categories.length ? (
        <Section title={t.profile.skillCategories} id="categories">
          <div className="grid-players">
            {categories.map((c) => (
              <div key={c.label} className="card card--outline">
                <h3 className="kicker">{c.label}</h3>
                <ul className="chips">{c.skills.map((k) => <li key={k}><span className="chip chip--sm">{pick(skills.status === 'success' ? skills.data.items.find((s) => s.key === k)?.name : null) || t.skills[k]}</span></li>)}</ul>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      <Section title={t.profile.challenges} id="challenges">
        {challengeVideos.length
          ? <div className="grid-cards">{challengeVideos.map((v) => <VideoCard key={v.id} video={v} showOwner={false} />)}</div>
          : <p className="muted small">{t.profile.challengesEmpty}</p>}
      </Section>

      {isScout && !isMe ? (
        <ScoutActions playerId={prof.userId} playerName={prof.displayName} canRequestContact={prof.canRequestContact} isMinor={prof.isMinor}
          open={sheet === 'scout'} onClose={() => setSheet(null)} />
      ) : null}
      <ReportSheet targetKind="user" targetId={prof.userId} open={sheet === 'report'} onClose={() => setSheet(null)} />
    </div>
  );
}
