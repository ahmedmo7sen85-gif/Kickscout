'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { SKILL_KEYS } from '@/lib/constants';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';
import type { SkillKey, VideoTag, VideoView } from '@/lib/types';

/**
 * Skill tags on a clip. AI-suggested tags are visibly marked "AI" with their confidence shown
 * subtly; tags the player added are plain. The owner can reject AI tags and add their own.
 * No score or rating is ever shown here.
 */
export function SkillTags({ tags, editable = false, videoId, onUpdated, compact = false }:
  { tags: VideoTag[]; editable?: boolean; videoId?: string; onUpdated?: (v: VideoView) => void; compact?: boolean }) {
  const { t, fmt, pick } = useI18n();
  const toast = useToast();
  const [rejected, setRejected] = useState<Set<SkillKey>>(new Set());
  const [added, setAdded] = useState<SkillKey[]>([]);
  const [adding, setAdding] = useState<SkillKey | ''>('');
  const [saving, setSaving] = useState(false);

  const aiTags = tags.filter((x) => x.source === 'ai');
  const userTags = tags.filter((x) => x.source === 'user');
  const present = new Set(tags.map((x) => x.skill));
  const dirty = rejected.size > 0 || added.length > 0;

  const toggleReject = (k: SkillKey) => setRejected((s) => {
    const n = new Set(s);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });

  const save = async () => {
    if (!videoId) return;
    setSaving(true);
    try {
      const v = await api.correctTags(videoId, { add: added, reject: [...rejected] });
      setRejected(new Set());
      setAdded([]);
      toast.show(t.tags.saved, { tone: 'success' });
      onUpdated?.(v);
    } catch (e) {
      toast.show(errorMessage(e, t), { tone: 'error' });
    } finally {
      setSaving(false);
    }
  };

  if (!tags.length && !editable) return compact ? null : <p className="muted small">{t.tags.none}</p>;

  return (
    <div className={`skill-tags${compact ? ' skill-tags--compact' : ''}`}>
      <ul className="skill-tags__list" aria-label={t.tags.title}>
        {userTags.map((tag) => {
          const name = pick(tag.name);
          return (
            <li key={`u-${tag.skill}`}>
              <span className="tag tag--player" data-source="user" title={t.tags.playerTag} aria-label={fmt(t.tags.playerTagLabel, { name })}>
                {name}
              </span>
            </li>
          );
        })}
        {added.map((k) => (
          <li key={`a-${k}`}>
            <span className="tag tag--player tag--pending" data-source="user">
              {t.skills[k]}
              <button type="button" className="tag__x" aria-label={`${t.common.remove} ${t.skills[k]}`} onClick={() => setAdded((xs) => xs.filter((x) => x !== k))}>
                <Icon name="close" size={12} />
              </button>
            </span>
          </li>
        ))}
        {aiTags.map((tag) => {
          const name = pick(tag.name);
          const pct = tag.confidence === null ? null : Math.round(tag.confidence * 100);
          const isRejected = rejected.has(tag.skill);
          return (
            <li key={`ai-${tag.skill}`}>
              <span
                className={`tag tag--ai${isRejected ? ' is-rejected' : ''}`}
                data-source="ai"
                title={t.tags.aiSuggested}
                aria-label={pct === null ? `${t.tags.aiSuggested}: ${name}` : fmt(t.tags.aiTagLabel, { name, pct })}
              >
                <span className="tag__ai" aria-hidden="true">{t.tags.aiBadge}</span>
                <span aria-hidden="true">{name}</span>
                {pct !== null && !compact ? <span className="tag__conf" aria-hidden="true">{pct}%</span> : null}
                {editable ? (
                  <button type="button" className="tag__x" aria-pressed={isRejected}
                    aria-label={isRejected ? `${t.tags.undoReject} ${name}` : fmt(t.tags.rejectLabel, { name })}
                    onClick={() => toggleReject(tag.skill)}>
                    <Icon name={isRejected ? 'check' : 'close'} size={12} />
                  </button>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      {aiTags.length && !compact ? <p className="skill-tags__note">{t.tags.aiNote}</p> : null}
      {editable ? (
        <div className="skill-tags__edit">
          <p className="small muted">{t.tags.correctHint}</p>
          <div className="row">
            <label className="sr-only" htmlFor={`add-tag-${videoId}`}>{t.tags.addLabel}</label>
            <select id={`add-tag-${videoId}`} className="input input--sm" value={adding} onChange={(e) => setAdding(e.target.value as SkillKey | '')}>
              <option value="">{t.tags.add}</option>
              {SKILL_KEYS.filter((k) => !present.has(k) && !added.includes(k)).map((k) => <option key={k} value={k}>{t.skills[k]}</option>)}
            </select>
            <Button size="sm" disabled={!adding || added.length >= 10} onClick={() => { if (adding) { setAdded((xs) => [...xs, adding]); setAdding(''); } }}>
              {t.upload.hashtagAdd}
            </Button>
            <Button size="sm" variant="primary" disabled={!dirty} loading={saving} onClick={save}>{t.tags.saveCorrections}</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
