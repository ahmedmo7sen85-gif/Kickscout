'use client';

import Link from 'next/link';
import { DemoBadge, VerifiedBadge } from '@/components/ui/Badge';
import { Icon } from '@/components/ui/Icon';
import { useI18n } from '@/lib/i18n/provider';
import type { VideoView } from '@/lib/types';

/** Grid card for a clip. Shows the processing status to the owner when it is not published. */
export function VideoCard({ video, showOwner = true, showStatus = false }: { video: VideoView; showOwner?: boolean; showStatus?: boolean }) {
  const { t, formatNumber } = useI18n();
  const hasAi = video.tags.some((x) => x.source === 'ai');
  return (
    <article className="video-card">
      <Link href={`/v/${video.id}`} className="video-card__link" aria-label={`${video.title} · @${video.owner.handle}`}>
        <div className="video-card__frame">
          {video.thumbnailUrl ? <img src={video.thumbnailUrl} alt="" loading="lazy" /> : <span className="video-card__placeholder" aria-hidden="true"><Icon name="play" size={28} /></span>}
          {showStatus && video.status !== 'published' ? <span className="video-card__status badge badge--outline">{t.videoStatus[video.status]}</span> : null}
          {hasAi ? <span className="video-card__ai badge badge--ai" title={t.tags.aiSuggested}>{t.tags.aiBadge}</span> : null}
          <div className="video-card__over">
            {video.skill ? <span className="video-card__skill">{t.skills[video.skill]}</span> : null}
            <b dir="auto">{video.title}</b>
            <span className="video-card__likes"><Icon name="heart" size={14} filled /> {formatNumber(video.likes)}</span>
          </div>
        </div>
      </Link>
      {showOwner ? (
        <p className="video-card__owner">
          <Link href={`/u/${video.owner.handle}`}>@{video.owner.handle}</Link>
          {video.owner.verified ? <VerifiedBadge compact /> : null}
          {video.owner.isDemo ? <DemoBadge /> : null}
        </p>
      ) : null}
    </article>
  );
}
