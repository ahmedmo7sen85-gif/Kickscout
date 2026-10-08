'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { PageHead } from '@/components/PageHead';
import { Button } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';
import { useApi } from '@/lib/useApi';
import type { NotificationView } from '@/lib/types';

const str = (v: unknown) => (typeof v === 'string' ? v : null);

/** Notification payloads vary by kind; show the server's text when it sends one, otherwise the kind. */
function describe(n: NotificationView, generic: string): { text: string; href: string | null } {
  const p = n.payload;
  const text = str(p.text) ?? str(p.message) ?? str(p.title) ?? generic.replace('{kind}', n.kind.replace(/[._]/g, ' '));
  const videoId = str(p.videoId);
  const handle = str(p.handle) ?? str(p.actorHandle);
  const slug = str(p.challengeSlug);
  const href = videoId ? `/v/${videoId}` : slug ? `/challenges/${slug}` : handle ? `/u/${handle}` : n.kind.startsWith('contact') ? '/settings#contact' : n.kind.startsWith('billing.') ? '/settings#billing' : null;
  return { text, href };
}

export function NotificationsView() {
  const { t } = useI18n();
  return (
    <div className="wrap wrap--mid page">
      <PageHead title={t.notifications.title} />
      <AuthGate><List /></AuthGate>
    </div>
  );
}

function List() {
  const { t, formatDate } = useI18n();
  const { refreshMe } = useAuth();
  const toast = useToast();
  const n = useApi((s) => api.notifications(undefined, s), []);
  const [busy, setBusy] = useState(false);
  const markAll = async () => {
    setBusy(true);
    try {
      await api.markRead({});
      n.setData((d) => ({ ...d, items: d.items.map((x) => ({ ...x, read: true })) }));
      void refreshMe();
    } catch (e) { toast.show(errorMessage(e, t), { tone: 'error' }); } finally { setBusy(false); }
  };

  if (n.status === 'loading') return <SkeletonList rows={5} label={t.common.loading} />;
  if (n.status === 'error') return <ErrorState error={n.error} title={t.notifications.errorTitle} onRetry={n.retry} />;
  if (!n.data.items.length) return <EmptyState icon="bell" title={t.notifications.empty} />;
  const unread = n.data.items.some((x) => !x.read);
  return (
    <div className="stack">
      {unread ? <div><Button size="sm" onClick={markAll} loading={busy}>{t.notifications.markAllRead}</Button></div> : null}
      <ul className="list">
        {n.data.items.map((x) => {
          const d = describe(x, t.notifications.generic);
          return (
            <li key={x.id} className={`notif${x.read ? '' : ' is-unread'}`}>
              <div className="list__row">
                {d.href ? <Link href={d.href} className="link" dir="auto">{d.text}</Link> : <span dir="auto">{d.text}</span>}
                <time className="muted small" dateTime={x.createdAt}>{formatDate(x.createdAt)}</time>
              </div>
              {!x.read ? <span className="sr-only">{t.notifications.unread}</span> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
