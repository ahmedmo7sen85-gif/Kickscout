'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { SkeletonList } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/States';
import { Tabs } from '@/components/ui/Tabs';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';
import { useApi } from '@/lib/useApi';

type Tab = 'shortlist' | 'note' | 'contact';

/** Verified-scout actions on a player: shortlist, private notes, contact request. The API enforces who may use them. */
export function ScoutActions({ playerId, playerName, canRequestContact, isMinor, open, onClose }:
  { playerId: string; playerName: string; canRequestContact: boolean; isMinor: boolean | null; open: boolean; onClose: () => void }) {
  const { t, fmt, formatDate } = useI18n();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('shortlist');
  const lists = useApi((s) => api.shortlists(s), [], { enabled: open && tab === 'shortlist' });
  const notes = useApi((s) => api.notes(playerId, s), [playerId], { enabled: open && tab === 'note' });
  const [newName, setNewName] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (key: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(key);
    try { await fn(); toast.show(success, { tone: 'success' }); return true; } catch (e) { toast.show(errorMessage(e, t), { tone: 'error' }); return false; } finally { setBusy(null); }
  };

  return (
    <Sheet open={open} onClose={onClose} title={`${t.profile.scoutTitle} · ${playerName}`} size="lg">
      <Tabs label={t.profile.scoutTitle} active={tab} onChange={setTab} items={[
        { id: 'shortlist', label: t.profile.addToShortlist },
        { id: 'note', label: t.profile.privateNote },
        { id: 'contact', label: t.profile.requestContact },
      ]} />
      {tab === 'shortlist' ? (
        <div className="stack">
          {lists.status === 'loading' ? <SkeletonList rows={2} label={t.common.loading} /> : null}
          {lists.status === 'error' ? <ErrorState error={lists.error} onRetry={lists.retry} /> : null}
          {lists.status === 'success' ? (
            lists.data.items.length ? (
              <ul className="list">
                {lists.data.items.map((l) => (
                  <li key={l.id} className="list__row">
                    <span>{l.name} <span className="muted small">· {fmt(t.common.playersCount, { n: l.players })}</span></span>
                    <Button size="sm" variant="primary" loading={busy === l.id} onClick={() => act(l.id, () => api.shortlistPlayer(l.id, playerId, true), fmt(t.profile.shortlistAdded, { name: l.name }))}>
                      {t.upload.hashtagAdd}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : <p className="muted">{t.profile.noShortlists}</p>
          ) : null}
          <form className="row" onSubmit={async (e) => {
            e.preventDefault();
            const name = newName.trim();
            if (!name) return;
            const ok = await act('new', async () => { const l = await api.createShortlist({ name }); await api.shortlistPlayer(l.id, playerId, true); }, fmt(t.profile.shortlistAdded, { name }));
            if (ok) { setNewName(''); lists.retry(); }
          }}>
            <label className="sr-only" htmlFor="new-list">{t.profile.newShortlistName}</label>
            <input id="new-list" className="input" style={{ flex: 1 }} maxLength={80} placeholder={t.profile.newShortlistName} value={newName} onChange={(e) => setNewName(e.target.value)} />
            <Button type="submit" loading={busy === 'new'} disabled={!newName.trim()}>{t.profile.createAndAdd}</Button>
          </form>
        </div>
      ) : null}
      {tab === 'note' ? (
        <div className="stack">
          <p className="muted small">{t.profile.privateNoteHint}</p>
          <form className="stack" onSubmit={async (e) => {
            e.preventDefault();
            const body = note.trim();
            if (!body) return;
            const ok = await act('note', async () => {
              const n = await api.addNote(playerId, { body });
              notes.setData((d) => ({ items: [n, ...d.items] }));
            }, t.common.saved);
            if (ok) setNote('');
          }}>
            <label className="sr-only" htmlFor="note">{t.profile.privateNote}</label>
            <textarea id="note" className="input" rows={3} maxLength={4000} placeholder={t.profile.notePlaceholder} value={note} onChange={(e) => setNote(e.target.value)} dir="auto" />
            <div><Button type="submit" variant="primary" loading={busy === 'note'} disabled={!note.trim()}>{t.profile.saveNote}</Button></div>
          </form>
          {notes.status === 'loading' ? <SkeletonList rows={2} label={t.common.loading} /> : null}
          {notes.status === 'error' ? <ErrorState error={notes.error} onRetry={notes.retry} /> : null}
          {notes.status === 'success' && notes.data.items.length === 0 ? <p className="muted small">{t.profile.notesEmpty}</p> : null}
          {notes.status === 'success' && notes.data.items.length > 0 ? (
            <ul className="list">
              {notes.data.items.map((n) => (
                <li key={n.id}>
                  <p dir="auto" style={{ whiteSpace: 'pre-wrap' }}>{n.body}</p>
                  <div className="list__row">
                    <time className="muted small" dateTime={n.updatedAt}>{formatDate(n.updatedAt)}</time>
                    <Button size="sm" variant="ghost" loading={busy === n.id}
                      onClick={async () => { if (await act(n.id, () => api.deleteNote(n.id), t.common.saved)) notes.setData((d) => ({ items: d.items.filter((x) => x.id !== n.id) })); }}>
                      {t.common.delete}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {tab === 'contact' ? (
        canRequestContact ? (
          <form className="stack" onSubmit={async (e) => {
            e.preventDefault();
            const ok = await act('contact', () => api.requestContact(playerId, { message: message.trim() }), t.profile.contactSent);
            if (ok) { setMessage(''); onClose(); }
          }}>
            {isMinor ? <p className="notice notice--warn small">{t.profile.minorNote}</p> : null}
            <p className="muted small">{t.profile.contactHint}</p>
            <label className="sr-only" htmlFor="contact-msg">{t.profile.requestContact}</label>
            <textarea id="contact-msg" className="input" rows={5} minLength={10} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} dir="auto" />
            <div><Button type="submit" variant="primary" loading={busy === 'contact'} disabled={message.trim().length < 10}>{t.profile.requestContact}</Button></div>
          </form>
        ) : <p className="notice">{t.profile.contactUnavailable}</p>
      ) : null}
    </Sheet>
  );
}
