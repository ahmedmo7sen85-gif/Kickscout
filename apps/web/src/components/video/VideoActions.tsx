'use client';

import { useState } from 'react';
import { IconButton } from '@/components/ui/IconButton';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { useAuthedAction } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n/provider';
import { absoluteUrl, shareLink } from '@/lib/share';
import { trackClient } from '@/components/Analytics';
import type { VideoView } from '@/lib/types';
import { CommentSheet } from './CommentSheet';
import { ReportSheet } from './ReportSheet';

/** Like, Comment, Share, Save and Report for one clip, with optimistic counts. */
export function VideoActions({ video, layout = 'rail' }: { video: VideoView; layout?: 'rail' | 'row' }) {
  const { t, fmt, formatNumber } = useI18n();
  const toast = useToast();
  const run = useAuthedAction();
  const [liked, setLiked] = useState(video.likedByMe);
  const [likes, setLikes] = useState(video.likes);
  const [saved, setSaved] = useState(video.savedByMe);
  const [saves, setSaves] = useState(video.saves);
  const [comments, setComments] = useState(video.comments);
  const [sheet, setSheet] = useState<'comments' | 'report' | null>(null);

  const toggleLike = async () => {
    const on = !liked;
    setLiked(on); setLikes((n) => n + (on ? 1 : -1));
    if (!(await run(() => api.like(video.id, on)))) { setLiked(!on); setLikes((n) => n - (on ? 1 : -1)); }
  };
  const toggleSave = async () => {
    const on = !saved;
    setSaved(on); setSaves((n) => n + (on ? 1 : -1));
    if (!(await run(() => api.save(video.id, on)))) { setSaved(!on); setSaves((n) => n - (on ? 1 : -1)); }
  };
  const share = async () => {
    const r = await shareLink(absoluteUrl(`/v/${video.id}`), video.title, fmt(t.feed.shareText, { handle: video.owner.handle }));
    if (r === 'shared' || r === 'copied') trackClient('share_clicked', { videoId: video.id });
    if (r === 'copied') toast.show(t.common.linkCopied, { tone: 'success' });
    if (r === 'failed') toast.show(t.common.copyFailed, { tone: 'error' });
  };

  return (
    <>
      <div className={`video-actions video-actions--${layout}`}>
        <IconButton icon="heart" filled={liked} active={liked} pressed={liked} label={liked ? t.feed.unlike : t.feed.like} count={formatNumber(likes)} onClick={toggleLike} />
        <IconButton icon="comment" label={t.feed.comment} count={formatNumber(comments)} onClick={() => setSheet('comments')} />
        <IconButton icon="share" label={t.feed.share} onClick={share} />
        <IconButton icon="bookmark" filled={saved} active={saved} pressed={saved} label={saved ? t.feed.unsave : t.feed.save} count={formatNumber(saves)} onClick={toggleSave} />
        <IconButton icon="flag" label={t.feed.report} onClick={() => setSheet('report')} />
      </div>
      <CommentSheet videoId={video.id} open={sheet === 'comments'} onClose={() => setSheet(null)} onPosted={() => setComments((n) => n + 1)} />
      <ReportSheet targetKind="video" targetId={video.id} open={sheet === 'report'} onClose={() => setSheet(null)} />
    </>
  );
}
