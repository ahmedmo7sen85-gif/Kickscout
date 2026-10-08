'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { SkeletonList } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';
import { useApi } from '@/lib/useApi';
import type { CommentView } from '@/lib/types';

export function CommentSheet({ videoId, open, onClose, onPosted }: { videoId: string; open: boolean; onClose: () => void; onPosted?: () => void }) {
  const { t, formatDate } = useI18n();
  const { status } = useAuth();
  const toast = useToast();
  const list = useApi((s) => api.comments(videoId, undefined, s), [videoId], { enabled: open });
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setPosting(true);
    try {
      const c = await api.addComment(videoId, { body: body.trim() });
      list.setData((d) => ({ ...d, items: [c, ...d.items] }));
      setBody('');
      toast.show(t.feed.commentPosted, { tone: 'success' });
      onPosted?.();
    } catch (err) {
      toast.show(errorMessage(err, t), { tone: 'error' });
    } finally {
      setPosting(false);
    }
  };

  const statusLabel = (c: CommentView) => (c.status === 'pending' ? t.feed.commentPending : c.status === 'held' ? t.feed.commentHeld : null);

  return (
    <Sheet open={open} onClose={onClose} title={t.feed.commentsTitle}
      footer={status === 'signed_in' ? (
        <form className="row" onSubmit={submit}>
          <label htmlFor={`c-${videoId}`} className="sr-only">{t.feed.commentLabel}</label>
          <input id={`c-${videoId}`} className="input" style={{ flex: 1 }} maxLength={2000} value={body}
            onChange={(e) => setBody(e.target.value)} placeholder={t.feed.commentPlaceholder} dir="auto" />
          <Button type="submit" variant="primary" loading={posting} disabled={!body.trim()}>{t.feed.commentPost}</Button>
        </form>
      ) : <p className="small muted">{t.feed.loginToAct}</p>}>
      {list.status === 'loading' ? <SkeletonList rows={3} label={t.common.loading} /> : null}
      {list.status === 'error' ? <ErrorState error={list.error} onRetry={list.retry} /> : null}
      {list.status === 'success' && list.data.items.length === 0 ? <EmptyState icon="comment" title={t.feed.commentsEmpty} /> : null}
      {list.status === 'success' && list.data.items.length > 0 ? (
        <ul className="comments">
          {list.data.items.filter((c) => c.status !== 'removed').map((c) => (
            <li key={c.id} className="comment">
              <div className="comment__head">
                <strong>@{c.author.handle}</strong>
                <time className="muted small" dateTime={c.createdAt}>{formatDate(c.createdAt)}</time>
                {statusLabel(c) ? <span className="badge badge--outline">{statusLabel(c)}</span> : null}
              </div>
              <p className="comment__body" dir="auto">{c.body}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </Sheet>
  );
}
