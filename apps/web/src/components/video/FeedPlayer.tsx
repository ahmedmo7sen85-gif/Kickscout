'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { DemoBadge, VerifiedBadge } from '@/components/ui/Badge';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { api } from '@/lib/api';
import { countryName, flagEmoji } from '@/lib/format';
import { useReducedMotion } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n/provider';
import { WhyThis } from '@/components/feed/Recommendations';
import type { FeedWhy, VideoView } from '@/lib/types';
import { FollowButton } from './FollowButton';
import { SkillTags } from './SkillTags';
import { VideoActions } from './VideoActions';

/**
 * Vertical, full-screen, snap-scrolling feed. The clip that is mostly on screen plays (muted by
 * default, looping); everything else pauses. Reduced-motion users get a play button instead of
 * autoplay.
 */
export function FeedPlayer({ videos, onNearEnd, hideFollow = false, why, onNotInterested }: {
  videos: VideoView[]; onNearEnd?: () => void; hideFollow?: boolean;
  /** For You: why each clip (by id) is shown. */
  why?: Record<string, FeedWhy>;
  /** For You, signed in: "Not interested" for a clip. */
  onNotInterested?: (videoId: string) => void;
}) {
  const [muted, setMuted] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (onNearEnd && activeIndex >= videos.length - 2) onNearEnd();
  }, [activeIndex, videos.length, onNearEnd]);

  return (
    <div className="feed" data-testid="feed">
      {videos.map((v, i) => (
        <FeedItem key={v.id} video={v} muted={muted} onToggleMute={() => setMuted((m) => !m)} onActive={() => setActiveIndex(i)} hideFollow={hideFollow}
          why={why?.[v.id]} onNotInterested={onNotInterested ? () => onNotInterested(v.id) : undefined} />
      ))}
    </div>
  );
}

function FeedItem({ video, muted, onToggleMute, onActive, hideFollow, why, onNotInterested }:
  { video: VideoView; muted: boolean; onToggleMute: () => void; onActive: () => void; hideFollow: boolean; why: FeedWhy | undefined; onNotInterested: (() => void) | undefined }) {
  const { t, fmt, locale } = useI18n();
  const reduced = useReducedMotion();
  const ref = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const viewed = useRef(false);
  const onActiveRef = useRef(onActive);
  onActiveRef.current = onActive;

  useEffect(() => {
    const el = ref.current;
    if (!el || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver(([entry]) => {
      const on = !!entry && entry.intersectionRatio >= 0.6;
      setVisible(on);
      if (on) onActiveRef.current();
    }, { threshold: [0, 0.6, 1] });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (visible && !reduced) v.play().catch(() => setPlaying(false));
    if (!visible) v.pause();
  }, [visible, reduced]);

  const onPlay = () => {
    setPlaying(true);
    if (!viewed.current) {
      viewed.current = true;
      api.recordView(video.id).catch(() => {});
    }
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  };

  const label = fmt(t.feed.videoLabel, { handle: video.owner.handle, title: video.title });
  const country = video.country ? `${flagEmoji(video.country)} ${countryName(video.country, locale)}`.trim() : null;

  return (
    <article ref={ref} className="feed-item" aria-label={label}>
      {video.playbackUrl ? (
        <video
          ref={videoRef}
          className="feed-item__video"
          src={video.playbackUrl}
          poster={video.thumbnailUrl ?? undefined}
          muted={muted}
          loop
          playsInline
          preload="metadata"
          aria-label={label}
          onClick={togglePlay}
          onPlay={onPlay}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            setProgress(v.duration ? v.currentTime / v.duration : 0);
          }}
        />
      ) : (
        <div className="feed-item__video feed-item__missing">
          {video.thumbnailUrl ? <img src={video.thumbnailUrl} alt="" /> : null}
          <p>{t.feed.noPlayback}</p>
        </div>
      )}

      <div className="feed-item__top">
        <IconButton icon={muted ? 'mute' : 'volume'} label={muted ? t.feed.unmute : t.feed.mute} pressed={!muted} onClick={onToggleMute} className="icon-btn--glass" />
        {video.playbackUrl ? (
          <IconButton icon={playing ? 'pause' : 'play'} label={playing ? t.feed.pause : t.feed.play} onClick={togglePlay} className="icon-btn--glass" />
        ) : null}
      </div>

      <div className="feed-item__overlay">
        <div className="feed-item__owner">
          <Link href={`/u/${video.owner.handle}`} className="feed-item__handle">@{video.owner.handle}</Link>
          {video.owner.verified ? <VerifiedBadge compact /> : null}
          {video.owner.isDemo ? <DemoBadge /> : null}
          {!hideFollow ? <FollowButton userId={video.owner.userId} /> : null}
        </div>
        <p className="feed-item__title" dir="auto">{video.title}</p>
        <p className="feed-item__meta">
          {video.skill ? <span className="feed-item__skill">{t.skills[video.skill]}</span> : null}
          {video.position ? <span>{t.positions[video.position]}</span> : null}
          {country ? <span>{country}</span> : null}
        </p>
        <SkillTags tags={video.tags} compact />
        <WhyThis why={why} onNotInterested={onNotInterested} />
        {video.hashtags.length ? (
          <p className="feed-item__hashtags">
            {video.hashtags.map((h) => <Link key={h} href={`/search?hashtag=${encodeURIComponent(h)}&type=videos`} dir="auto">#{h}</Link>)}
          </p>
        ) : null}
      </div>

      <VideoActions video={video} />

      <div className="feed-item__progress" aria-hidden="true"><span style={{ inlineSize: `${Math.round(progress * 1000) / 10}%` }} /></div>
      {reduced && !playing && video.playbackUrl ? (
        <button type="button" className="feed-item__bigplay" onClick={togglePlay} aria-label={t.feed.play}><Icon name="play" size={40} filled /></button>
      ) : null}
    </article>
  );
}
