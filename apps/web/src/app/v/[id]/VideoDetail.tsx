'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Avatar } from '@/components/player/PlayerCard';
import { DemoBadge, VerifiedBadge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { FollowButton } from '@/components/video/FollowButton';
import { SkillTags } from '@/components/video/SkillTags';
import { VideoActions } from '@/components/video/VideoActions';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import { countryName, flagEmoji } from '@/lib/format';
import { useI18n } from '@/lib/i18n/provider';
import { useApi } from '@/lib/useApi';

export function VideoDetail({ id }: { id: string }) {
  const { t, fmt, locale, formatDate } = useI18n();
  const { me, status } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const v = useApi((s) => api.video(id, s), [id, status]);
  const [deleting, setDeleting] = useState(false);

  if (v.status === 'loading') {
    return (
      <div className="wrap page" role="status" aria-label={t.common.loading}>
        <div className="split split--wide-side"><Skeleton height="min(75dvh, 40rem)" radius="1rem" /><div className="stack"><Skeleton width="60%" height="2rem" /><Skeleton width="80%" /></div></div>
      </div>
    );
  }
  if (v.status === 'error') {
    return (
      <div className="wrap page">
        {v.error.status === 404 ? <EmptyState icon="play" title={t.errors.NOT_FOUND} action={<ButtonLink href="/discover">{t.nav.discover}</ButtonLink>} />
          : <ErrorState error={v.error} onRetry={v.retry} />}
      </div>
    );
  }
  const video = v.data;
  const isOwner = me?.userId === video.owner.userId;
  const remove = async () => {
    if (!window.confirm(t.common.delete)) return;
    setDeleting(true);
    try {
      await api.deleteVideo(video.id);
      router.push(me ? `/u/${me.profile.handle}` : '/');
    } catch (e) {
      toast.show(errorMessage(e, t), { tone: 'error' });
      setDeleting(false);
    }
  };

  return (
    <div className="wrap page">
      <div className="split split--wide-side">
        <div className="upload-preview" style={{ maxInlineSize: '28rem', marginInline: 'auto', inlineSize: '100%' }}>
          {video.playbackUrl ?? video.privatePlaybackUrl ? (
            <video src={(video.playbackUrl ?? video.privatePlaybackUrl)!} poster={video.thumbnailUrl ?? undefined} controls playsInline muted loop preload="metadata"
              aria-label={fmt(t.feed.videoLabel, { handle: video.owner.handle, title: video.title })} />
          ) : <div className="feed-item__missing" style={{ blockSize: '100%' }}><p>{t.feed.noPlayback}</p></div>}
        </div>
        <div className="stack">
          {isOwner && video.status !== 'published' ? (
            <p className="notice notice--warn"><strong>{t.videoStatus[video.status]}</strong> {t.videoStatus[`${video.status}Text`]}
              {video.statusReason ? ` ${fmt(t.videoStatus.reason, { reason: video.statusReason })}` : ''}
              {video.safetyStatus ? <><br /><span className="small">{fmt(t.guardianCheck.safetyStatus, { status: t.guardianCheck.status[video.safetyStatus] })}</span></> : null}</p>
          ) : null}
          {isOwner && video.canAppeal ? <AppealForm videoId={video.id} onSent={() => v.setData((d) => ({ ...d, canAppeal: false }))} /> : null}
          <div className="row">
            <Link href={`/u/${video.owner.handle}`} className="player-card__main">
              <Avatar src={video.owner.avatarUrl} name={video.owner.displayName} size={44} />
              <span><strong dir="auto">{video.owner.displayName}</strong><br /><span className="muted small">@{video.owner.handle}</span></span>
            </Link>
            {video.owner.verified ? <VerifiedBadge compact /> : null}
            {video.owner.isDemo ? <DemoBadge /> : null}
            <FollowButton userId={video.owner.userId} />
          </div>
          <h1 className="section-title" style={{ fontSize: '1.8rem', textTransform: 'none' }} dir="auto">{video.title}</h1>
          {video.description ? <p dir="auto" className="muted">{video.description}</p> : null}
          <p className="feed-item__meta">
            {video.skill ? <span className="feed-item__skill">{t.skills[video.skill]}</span> : null}
            {video.position ? <span>{t.positions[video.position]}</span> : null}
            {video.foot ? <span>{t.feet[video.foot]}</span> : null}
            {video.country ? <span>{flagEmoji(video.country)} {countryName(video.country, locale)}</span> : null}
            {video.publishedAt ? <time dateTime={video.publishedAt}>{formatDate(video.publishedAt)}</time> : null}
          </p>
          {video.hashtags.length ? (
            <p className="feed-item__hashtags">{video.hashtags.map((h) => <Link key={h} href={`/search?type=videos&hashtag=${encodeURIComponent(h)}`} dir="auto">#{h}</Link>)}</p>
          ) : null}
          <div className="card">
            <h2 className="section-title" style={{ fontSize: '1.1rem' }}>{t.tags.title}</h2>
            <SkillTags tags={video.tags} editable={isOwner} videoId={video.id} onUpdated={(nv) => v.setData(() => nv)} />
          </div>
          <VideoActions video={video} layout="row" />
          {isOwner ? <div><Button variant="danger" size="sm" loading={deleting} onClick={remove}>{t.common.delete}</Button></div> : null}
        </div>
      </div>
    </div>
  );
}

/** Appeal a Guardian rejection or removal. A different moderator looks at it. */
function AppealForm({ videoId, onSent }: { videoId: string; onSent: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.appealVideo(videoId, { explanation: text.trim() });
      toast.show(t.guardianCheck.appealSent, { tone: 'success' });
      onSent();
    } catch (err) { toast.show(errorMessage(err, t), { tone: 'error' }); } finally { setBusy(false); }
  };
  return (
    <form className="card card--outline stack stack--tight" onSubmit={submit} data-testid="appeal-form">
      <strong>{t.guardianCheck.appealTitle}</strong>
      <label className="field"><span className="field__label muted small">{t.guardianCheck.appealHint}</span>
        <textarea className="input" rows={3} required minLength={10} maxLength={2000} dir="auto" value={text} onChange={(e) => setText(e.target.value)} /></label>
      <div><Button type="submit" variant="primary" size="sm" loading={busy}>{t.guardianCheck.appealSubmit}</Button></div>
    </form>
  );
}
