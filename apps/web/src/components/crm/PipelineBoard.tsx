'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { CRM_STAGES } from '@fp/domain';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/lib/i18n/provider';
import type { CrmEntryView, CrmStage } from '@/lib/types';

export interface PipelineBoardProps {
  items: CrmEntryView[];
  /** False for roles that may only read (viewer, analyst): no move controls are shown. */
  canWrite: boolean;
  busyId?: string | null;
  onMove?: (entry: CrmEntryView, stage: CrmStage, message?: string) => void | Promise<unknown>;
}

/**
 * Kanban board, one column per stage. Fully keyboard operable without drag and drop: every card
 * has buttons for the previous and next stage and a "move to" list. Moving to Contact Requested
 * asks for the message first, because it sends a real contact request.
 */
export function PipelineBoard({ items, canWrite, busyId, onMove }: PipelineBoardProps) {
  const { t, fmt, dir } = useI18n();
  const [contactFor, setContactFor] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const stages = CRM_STAGES as readonly CrmStage[];
  const name = (s: CrmStage) => t.crmStages[s];
  const back = dir === 'rtl' ? '→' : '←';
  const fwd = dir === 'rtl' ? '←' : '→';

  const move = (e: CrmEntryView, to: CrmStage) => {
    if (to === e.stage) return;
    if (to === 'contact_requested') { setContactFor(e.id); setMessage(''); return; }
    void onMove?.(e, to);
  };
  const sendContact = (ev: FormEvent, e: CrmEntryView) => {
    ev.preventDefault();
    if (message.trim().length < 10) return;
    void Promise.resolve(onMove?.(e, 'contact_requested', message.trim())).then(() => setContactFor(null));
  };

  return (
    <div className="kanban" role="group" aria-label={t.pipeline.boardLabel} data-testid="pipeline-board">
      {stages.map((stage, i) => {
        const cards = items.filter((x) => x.stage === stage);
        const headingId = `stage-${stage}`;
        return (
          <section key={stage} className="kanban__col" aria-labelledby={headingId} data-stage={stage}>
            <div className="kanban__head">
              <h3 className="kanban__title" id={headingId}>{name(stage)}</h3>
              <span className="muted small">{fmt(t.pipeline.columnCount, { n: cards.length })}</span>
            </div>
            {cards.length ? (
              <ul className="kanban__list" aria-labelledby={headingId}>
                {cards.map((e) => {
                  const prev = stages[i - 1];
                  const next = stages[i + 1];
                  const who = e.player.displayName;
                  return (
                    <li key={e.id} className="kanban__card" data-entry={e.id}>
                      <Link className="link" href={`/u/${e.player.handle}`} dir="auto">{who}</Link>
                      <span className="muted small">@{e.player.handle}</span>
                      {e.tags.length ? (
                        <ul className="row" aria-label={t.pipeline.tags} style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                          {e.tags.map((tag) => <li key={tag} className="badge badge--outline" dir="auto">{tag}</li>)}
                        </ul>
                      ) : null}
                      {e.contactRequest ? (
                        <span className={`badge ${e.contactRequest.status === 'accepted' ? 'badge--green' : 'badge--outline'}`}>
                          {fmt(t.pipeline.contactStatus, { status: t.contact[e.contactRequest.status] })}
                          {e.contactRequest.viaGuardian ? ` · ${t.contact.viaGuardian}` : ''}
                        </span>
                      ) : null}
                      {canWrite ? (
                        <div className="kanban__moves">
                          {prev ? (
                            <Button size="sm" variant="ghost" disabled={busyId === e.id} aria-label={fmt(t.pipeline.moveLeft, { name: who, stage: name(prev) })} onClick={() => move(e, prev)}>
                              {back}
                            </Button>
                          ) : null}
                          <label className="sr-only" htmlFor={`move-${e.id}`}>{fmt(t.pipeline.moveTo, { name: who })}</label>
                          <select id={`move-${e.id}`} className="input input--sm" value={e.stage} disabled={busyId === e.id}
                            onChange={(ev) => move(e, ev.target.value as CrmStage)}>
                            {stages.map((s) => <option key={s} value={s}>{name(s)}</option>)}
                          </select>
                          {next ? (
                            <Button size="sm" variant="ghost" disabled={busyId === e.id} aria-label={fmt(t.pipeline.moveRight, { name: who, stage: name(next) })} onClick={() => move(e, next)}>
                              {fwd}
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                      {contactFor === e.id ? (
                        <form className="stack stack--tight" onSubmit={(ev) => sendContact(ev, e)}>
                          <label className="field">
                            <span className="field__label">{t.pipeline.contactMessage}</span>
                            <textarea className="input" required minLength={10} maxLength={1000} rows={3} value={message} onChange={(ev) => setMessage(ev.target.value)} dir="auto" />
                            <span className="field__hint">{t.pipeline.contactHint}</span>
                          </label>
                          <div className="row">
                            <Button type="submit" size="sm" variant="primary" loading={busyId === e.id} disabled={message.trim().length < 10}>{t.pipeline.sendContact}</Button>
                            <Button size="sm" variant="ghost" onClick={() => setContactFor(null)}>{t.common.cancel}</Button>
                          </div>
                        </form>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : <p className="muted small">{t.pipeline.empty}</p>}
          </section>
        );
      })}
    </div>
  );
}
