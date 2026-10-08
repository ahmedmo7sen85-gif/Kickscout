'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PageHead } from '@/components/PageHead';
import { PlayerCard } from '@/components/player/PlayerCard';
import { Button, ButtonLink } from '@/components/ui/Button';
import { SkeletonGrid } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';
import { useApi } from '@/lib/useApi';
import { ScoutGate } from '../../ScoutGate';

export function ShortlistDetailView({ id }: { id: string }) {
  return <ScoutGate><Detail id={id} /></ScoutGate>;
}

function Detail({ id }: { id: string }) {
  const { t, fmt, formatDate } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const s = useApi((sig) => api.shortlist(id, sig), [id]);
  const [busy, setBusy] = useState<string | null>(null);

  const removePlayer = async (playerId: string) => {
    setBusy(playerId);
    try {
      await api.shortlistPlayer(id, playerId, false);
      s.setData((d) => ({ ...d, players: d.players - 1, items: d.items.filter((x) => x.userId !== playerId) }));
    } catch (e) { toast.show(errorMessage(e, t), { tone: 'error' }); } finally { setBusy(null); }
  };
  const removeList = async () => {
    if (!window.confirm(t.scout.deleteShortlist)) return;
    setBusy('list');
    try { await api.deleteShortlist(id); router.push('/scout'); } catch (e) { toast.show(errorMessage(e, t), { tone: 'error' }); setBusy(null); }
  };

  return (
    <div className="wrap page">
      <div><ButtonLink href="/scout" variant="ghost" size="sm">← {t.scout.backToDashboard}</ButtonLink></div>
      {s.status === 'loading' ? <SkeletonGrid count={4} aspect="4 / 3" label={t.common.loading} /> : null}
      {s.status === 'error' ? <ErrorState error={s.error} title={t.scout.errorTitle} onRetry={s.retry} /> : null}
      {s.status === 'success' ? (
        <>
          <PageHead title={s.data.name} intro={fmt(t.common.playersCount, { n: s.data.players })}
            actions={<Button variant="danger" size="sm" loading={busy === 'list'} onClick={removeList}>{t.scout.deleteShortlist}</Button>} />
          {s.data.items.length === 0 ? <EmptyState icon="scout" title={t.scout.shortlistEmpty} action={<ButtonLink href="/scout">{t.scout.searchTitle}</ButtonLink>} /> : (
            <div className="grid-players">
              {s.data.items.map((p) => (
                <PlayerCard key={p.userId} player={p} footer={
                  <>
                    <span className="muted small">{fmt(t.scout.added, { date: formatDate(p.addedAt) })}</span>
                    <Button size="sm" variant="ghost" loading={busy === p.userId} onClick={() => removePlayer(p.userId)}>{t.scout.removePlayer}</Button>
                  </>
                } />
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
