'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { PageHead } from '@/components/PageHead';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { AuthNotConfigured } from '@/components/ui/States';
import { SkillTags } from '@/components/video/SkillTags';
import { api, isApiError, putSignedUpload } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  FEET, MAX_DURATION_MS, MAX_HASHTAGS, MAX_UPLOAD_BYTES, normalizeHashtag, POSITIONS, SKILL_KEYS, VIDEO_CONTENT_TYPES, VIDEO_CONTEXTS, VISIBILITIES,
} from '@/lib/constants';
import { errorMessage } from '@/lib/errors';
import { formatBytes, formatDuration } from '@/lib/format';
import { useI18n } from '@/lib/i18n/provider';
import type { CreateUploadRequest, Foot, Position, SkillKey, VideoContentType, VideoContext, VideoStatus, VideoView, Visibility } from '@/lib/types';

const TOTAL = 10;
const ACTIVE_STATUSES: VideoStatus[] = ['uploading', 'processing', 'analyzing', 'review_required'];
const TIMELINE: VideoStatus[] = ['uploading', 'processing', 'analyzing', 'published'];

/** Best guess at the content type; the server checks the real bytes. */
export function detectContentType(file: { type: string; name: string }): VideoContentType | null {
  if ((VIDEO_CONTENT_TYPES as readonly string[]).includes(file.type)) return file.type as VideoContentType;
  const ext = file.name.toLowerCase().split('.').pop();
  if (ext === 'mp4' || ext === 'm4v') return 'video/mp4';
  if (ext === 'mov') return 'video/quicktime';
  if (ext === 'webm') return 'video/webm';
  return null;
}

type Phase = { kind: 'edit' } | { kind: 'sending'; progress: number } | { kind: 'tracking'; video: VideoView } | { kind: 'error'; message: string; videoId: string | null };

export function UploadFlow() {
  const { t, fmt } = useI18n();
  const { status: authStatus, me, isPlayer } = useAuth();
  const params = useSearchParams();
  const challengeId = params.get('challenge') ?? undefined;

  const [step, setStep] = useState(1);
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [metaFailed, setMetaFailed] = useState(false);
  const [trim, setTrim] = useState<[number, number]>([0, 0]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [skill, setSkill] = useState<SkillKey | ''>('');
  const [position, setPosition] = useState<Position | ''>('');
  const [foot, setFoot] = useState<Foot | ''>('');
  const [context, setContext] = useState<VideoContext | ''>(challengeId ? 'challenge' : '');
  const [hashtags, setHashtags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState('');
  const [tagError, setTagError] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<Visibility>('public');
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'edit' });
  const previewRef = useRef<HTMLVideoElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Prefill position from the player's profile.
  const profilePos = me?.profile.player?.primaryPosition ?? null;
  useEffect(() => { if (profilePos && !position) setPosition(profilePos); }, [profilePos, position]);

  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const contentType = file ? detectContentType(file) : null;
  const checks = useMemo(() => {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (file) {
      if (!contentType) errors.push(t.upload.badType);
      if (file.size > MAX_UPLOAD_BYTES) errors.push(fmt(t.upload.tooBig, { size: formatBytes(file.size) }));
      if (durationMs !== null && durationMs > MAX_DURATION_MS) warnings.push(fmt(t.upload.tooLong, { duration: formatDuration(durationMs) }));
    }
    return { errors, warnings };
  }, [file, contentType, durationMs, t, fmt]);

  const trimLen = trim[1] - trim[0];
  const trimValid = durationMs === null || (trim[1] > trim[0] && trimLen <= MAX_DURATION_MS);
  const canNext: Record<number, boolean> = {
    1: !!file && checks.errors.length === 0,
    2: true,
    3: trimValid,
    4: title.trim().length > 0 && title.trim().length <= 100,
    5: !!skill,
    6: true,
    7: true,
    8: true,
    9: true,
    10: true,
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (url) URL.revokeObjectURL(url);
    setFile(f);
    setUrl(URL.createObjectURL(f));
    setDurationMs(null);
    setMetaFailed(false);
    setTrim([0, 0]);
    if (!title) setTitle('');
  };

  const onMeta = (el: HTMLVideoElement) => {
    const d = Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : null;
    if (d) {
      setDurationMs(d);
      setTrim([0, Math.min(d, MAX_DURATION_MS)]);
    }
  };

  const addTag = () => {
    const tag = normalizeHashtag(tagDraft);
    if (!tag) { setTagError(t.upload.hashtagInvalid); return; }
    if (hashtags.length >= MAX_HASHTAGS) { setTagError(t.upload.hashtagMax); return; }
    if (!hashtags.includes(tag)) setHashtags([...hashtags, tag]);
    setTagDraft('');
    setTagError(null);
  };
  const onTagKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') { e.preventDefault(); addTag(); }
  };

  const trimmed = durationMs !== null && (trim[0] > 0 || trim[1] < durationMs);

  const publish = async () => {
    if (!file || !contentType || !rightsConfirmed) return;
    const body: CreateUploadRequest = {
      rightsConfirmed: true,
      contentType,
      sizeBytes: file.size,
      title: title.trim(),
      description: description.trim() || undefined,
      skillKey: skill || undefined,
      position: position || undefined,
      foot: foot || undefined,
      context: context || undefined,
      hashtags,
      visibility,
      trimStartMs: trimmed ? Math.round(trim[0]) : undefined,
      trimEndMs: trimmed ? Math.round(trim[1]) : undefined,
      challengeId,
    };
    let videoId: string | null = null;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      setPhase({ kind: 'sending', progress: 0 });
      const created = await api.createUpload(body);
      videoId = created.videoId;
      await putSignedUpload(created.upload, file, (p) => setPhase({ kind: 'sending', progress: p }), ctrl.signal);
      const video = await api.completeUpload(created.videoId);
      setPhase({ kind: 'tracking', video });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setPhase({ kind: 'error', message: errorMessage(e, t), videoId });
      if (isApiError(e) && e.code === 'NOT_REGISTERED') window.location.assign('/onboarding');
    }
  };

  // Poll the clip's status until it settles.
  const trackingId = phase.kind === 'tracking' ? phase.video.id : null;
  const trackingStatus = phase.kind === 'tracking' ? phase.video.status : null;
  useEffect(() => {
    if (!trackingId || !trackingStatus || !ACTIVE_STATUSES.includes(trackingStatus)) return;
    const delay = trackingStatus === 'review_required' ? 15_000 : 3_000;
    const timer = window.setTimeout(() => {
      api.video(trackingId).then((video) => setPhase({ kind: 'tracking', video }), () => setPhase((p) => (p.kind === 'tracking' ? { ...p } : p)));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [trackingId, trackingStatus, phase]);

  const reset = () => {
    setStep(1); setFile(null); setUrl(null); setDurationMs(null); setTrim([0, 0]); setTitle(''); setDescription('');
    setSkill(''); setFoot(''); setHashtags([]); setVisibility('public'); setRightsConfirmed(false); setPhase({ kind: 'edit' });
  };

  if (phase.kind !== 'edit') {
    return (
      <div className="wrap wrap--narrow page">
        <PageHead title={t.upload.progressTitle} intro={title} />
        <UploadStatus phase={phase} onRetry={phase.kind === 'error' && !phase.videoId ? publish : undefined}
          onTagsUpdated={(video) => setPhase({ kind: 'tracking', video })} />
        <div className="cta-row">
          {phase.kind === 'tracking' && phase.video.status === 'published' ? <ButtonLink href={`/v/${phase.video.id}`} variant="primary">{t.upload.viewVideo}</ButtonLink> : null}
          {phase.kind !== 'sending' ? <Button onClick={reset}>{t.upload.startOver}</Button> : null}
        </div>
      </div>
    );
  }

  const stepNames = [t.upload.step1, t.upload.step2, t.upload.step3, t.upload.step4, t.upload.step5, t.upload.step6, t.upload.step7, t.upload.step8, t.upload.step9, t.upload.step10];
  const pct = (ms: number) => (durationMs ? (ms / durationMs) * 100 : 0);

  return (
    <div className="wrap wrap--narrow page">
      <PageHead title={t.upload.title} kicker={fmt(t.upload.stepOf, { n: step, total: TOTAL })} />
      <div className="stepper" aria-hidden="true">
        {stepNames.map((n, i) => <span key={n} className={i + 1 < step ? 'is-done' : i + 1 === step ? 'is-current' : ''} />)}
      </div>
      {authStatus === 'unconfigured' ? <AuthNotConfigured /> : null}
      {challengeId ? <p className="notice notice--accent">{t.upload.challengeNote}</p> : null}

      <section className="card" aria-labelledby="step-title" data-testid="upload-step">
        <h2 id="step-title" className="section-title">{stepNames[step - 1]}</h2>

        {step === 1 ? (
          <div className="stack">
            <label className="dropzone">
              <span className="dropzone__icon"><Icon name="plus" size={30} /></span>
              <strong>{file ? t.upload.changeFile : t.upload.chooseFile}</strong>
              <span className="muted small">{t.upload.selectHint}</span>
              <input type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm,.m4v" className="sr-only" onChange={onFile} />
            </label>
            {file ? (
              <p className="small" dir="auto">{fmt(t.upload.selectedFile, { name: file.name, size: formatBytes(file.size), duration: durationMs !== null ? formatDuration(durationMs) : '–' })}</p>
            ) : null}
            {url ? <video src={url} preload="metadata" muted hidden onLoadedMetadata={(e) => onMeta(e.currentTarget)} onError={() => setMetaFailed(true)} /> : null}
            {checks.errors.map((e) => <p key={e} className="field__error" role="alert">{e}</p>)}
            {checks.warnings.map((w) => <p key={w} className="notice notice--warn small">{w}</p>)}
            <p className="field__hint">{t.upload.checksNote}</p>
          </div>
        ) : null}

        {step === 2 && url ? (
          <div className="stack">
            <p className="muted small">{t.upload.previewHint}</p>
            <div className="upload-preview"><video src={url} controls playsInline muted preload="metadata" /></div>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="trim">
            <p className="muted small">{t.upload.trimHint}</p>
            {url ? <div className="upload-preview"><video ref={previewRef} src={url} playsInline muted preload="metadata" controls /></div> : null}
            {durationMs ? (
              <>
                <div className="trim__bar">
                  <div className="trim__track" />
                  <div className="trim__range" style={{ insetInlineStart: `${pct(trim[0])}%`, inlineSize: `${pct(trim[1]) - pct(trim[0])}%` }} />
                  <input type="range" min={0} max={durationMs} step={100} value={trim[0]} aria-label={t.upload.trimStart}
                    aria-valuetext={formatDuration(trim[0])}
                    onChange={(e) => { const v = Math.min(Number(e.target.value), trim[1] - 500); setTrim([Math.max(0, v), trim[1]]); if (previewRef.current) previewRef.current.currentTime = v / 1000; }} />
                  <input type="range" min={0} max={durationMs} step={100} value={trim[1]} aria-label={t.upload.trimEnd}
                    aria-valuetext={formatDuration(trim[1])}
                    onChange={(e) => { const v = Math.max(Number(e.target.value), trim[0] + 500); setTrim([trim[0], Math.min(durationMs, v)]); if (previewRef.current) previewRef.current.currentTime = v / 1000; }} />
                </div>
                <div className="row row--between small">
                  <span>{t.upload.trimStart}: {formatDuration(trim[0])}</span>
                  <span>{fmt(t.upload.trimLength, { duration: formatDuration(trimLen) })}</span>
                  <span>{t.upload.trimEnd}: {formatDuration(trim[1])}</span>
                </div>
                {!trimValid ? <p className="field__error" role="alert">{t.upload.trimTooLong}</p> : null}
              </>
            ) : <p className="notice small">{metaFailed ? t.upload.checksNote : t.common.loading}</p>}
          </div>
        ) : null}

        {step === 4 ? (
          <div className="stack">
            <label className="field">
              <span className="field__label">{t.upload.titleLabel}</span>
              <input className="input" value={title} maxLength={100} required placeholder={t.upload.titlePlaceholder} onChange={(e) => setTitle(e.target.value)} dir="auto" />
            </label>
            <label className="field">
              <span className="field__label">{t.upload.descriptionLabel} · {t.common.optional}</span>
              <textarea className="input" rows={3} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} dir="auto" />
            </label>
          </div>
        ) : null}

        {step === 5 ? (
          <div className="stack">
            <p className="muted small">{t.upload.skillHint}</p>
            <div className="choice-grid" role="radiogroup" aria-label={t.upload.skillTitle}>
              {SKILL_KEYS.map((k) => (
                <button key={k} type="button" role="radio" aria-checked={skill === k} className={`choice${skill === k ? ' is-active' : ''}`} onClick={() => setSkill(k)}>{t.skills[k]}</button>
              ))}
            </div>
          </div>
        ) : null}

        {step === 6 ? (
          <div className="stack">
            <p className="muted small">{t.upload.positionHint}</p>
            <div className="choice-grid" role="radiogroup" aria-label={t.upload.positionTitle}>
              {POSITIONS.map((p) => (
                <button key={p} type="button" role="radio" aria-checked={position === p} className={`choice${position === p ? ' is-active' : ''}`} onClick={() => setPosition(position === p ? '' : p)}>
                  {t.positions[p]}<small>{p}</small>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {step === 7 ? (
          <div className="stack">
            <div className="choice-grid" role="radiogroup" aria-label={t.upload.footTitle}>
              {FEET.map((f) => (
                <button key={f} type="button" role="radio" aria-checked={foot === f} className={`choice${foot === f ? ' is-active' : ''}`} onClick={() => setFoot(foot === f ? '' : f)}>{t.feet[f]}</button>
              ))}
            </div>
            <p className="muted small">{t.common.optional}</p>
          </div>
        ) : null}

        {step === 8 ? (
          <div className="stack">
            <p className="muted small">{t.upload.hashtagsHint}</p>
            <div className="row">
              <label htmlFor="tag" className="sr-only">{t.upload.hashtagLabel}</label>
              <input id="tag" className="input" style={{ flex: 1 }} value={tagDraft} maxLength={41} placeholder="#elasticochallenge"
                onChange={(e) => { setTagDraft(e.target.value); setTagError(null); }} onKeyDown={onTagKey} dir="auto" />
              <Button onClick={addTag} disabled={!tagDraft.trim() || hashtags.length >= MAX_HASHTAGS}>{t.upload.hashtagAdd}</Button>
            </div>
            {tagError ? <p className="field__error" role="alert">{tagError}</p> : null}
            <ul className="chips">
              {hashtags.map((h) => (
                <li key={h}>
                  <span className="chip chip--hashtag" dir="auto">#{h}
                    <button type="button" className="tag__x" aria-label={fmt(t.upload.removeHashtag, { tag: h })} onClick={() => setHashtags(hashtags.filter((x) => x !== h))}><Icon name="close" size={12} /></button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {step === 9 ? (
          <div className="stack">
            <fieldset className="radio-list">
              <legend className="field__label">{t.upload.privacyTitle}</legend>
              {VISIBILITIES.map((v) => (
                <label key={v} className={`radio-row${visibility === v ? ' is-checked' : ''}`}>
                  <input type="radio" name="visibility" value={v} checked={visibility === v} onChange={() => setVisibility(v)} />
                  <span><strong>{t.visibility[v]}</strong><br /><span className="small muted">{t.visibility[`${v}Text`]}</span></span>
                </label>
              ))}
            </fieldset>
            <label className="field">
              <span className="field__label">{t.upload.contextLabel} · {t.common.optional}</span>
              <select className="input" value={context} onChange={(e) => setContext(e.target.value as VideoContext | '')}>
                <option value="">{t.upload.none}</option>
                {VIDEO_CONTEXTS.map((c) => <option key={c} value={c}>{t.contexts[c]}</option>)}
              </select>
            </label>
          </div>
        ) : null}

        {step === 10 ? (
          <div className="stack">
            <p className="muted small">{t.upload.reviewHint}</p>
            <dl className="summary">
              <dt>{t.upload.titleLabel}</dt><dd dir="auto">{title}</dd>
              <dt>{t.upload.summarySkill}</dt><dd>{skill ? t.skills[skill] : t.upload.none}</dd>
              <dt>{t.upload.summaryPosition}</dt><dd>{position ? t.positions[position] : t.upload.none}</dd>
              <dt>{t.upload.summaryFoot}</dt><dd>{foot ? t.feet[foot] : t.upload.none}</dd>
              <dt>{t.upload.summaryHashtags}</dt><dd dir="auto">{hashtags.length ? hashtags.map((h) => `#${h}`).join(' ') : t.upload.none}</dd>
              <dt>{t.upload.summaryPrivacy}</dt><dd>{t.visibility[visibility]}</dd>
              <dt>{t.upload.summaryTrim}</dt><dd>{trimmed ? `${formatDuration(trim[0])} – ${formatDuration(trim[1])}` : t.upload.none}</dd>
              <dt>{t.upload.summaryContext}</dt><dd>{context ? t.contexts[context] : t.upload.none}</dd>
            </dl>
            <fieldset className="stack stack--tight" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="field__label">{t.upload.rightsTitle}</legend>
              <label className={`check-row${rightsConfirmed ? ' is-checked' : ''}`}>
                <input type="checkbox" checked={rightsConfirmed} onChange={(e) => setRightsConfirmed(e.target.checked)} data-testid="rights-confirm" />
                <span>{t.upload.rightsLabel}</span>
              </label>
              <span className="field__hint">{t.upload.rightsHint} <a className="link" href="/legal/copyright">{t.legal.copyright}</a></span>
              {!rightsConfirmed ? <span className="small muted">{t.upload.rightsRequired}</span> : null}
            </fieldset>
            <p className="field__hint">{t.upload.checksNote}</p>
            {authStatus === 'signed_out' ? <p className="notice notice--warn">{t.upload.loginRequired} <a className="link" href="/login">{t.common.logIn}</a></p> : null}
            {me && !isPlayer ? <p className="notice notice--warn">{t.upload.playerRoleRequired}</p> : null}
          </div>
        ) : null}
      </section>

      <div className="row row--between">
        <Button variant="ghost" onClick={() => setStep((s) => Math.max(1, s - 1))} disabled={step === 1}>{t.common.back}</Button>
        <div className="row">
          {step === 7 ? <Button variant="ghost" onClick={() => { setFoot(''); setStep(8); }}>{t.upload.footSkip}</Button> : null}
          {step < TOTAL ? (
            <Button variant="primary" onClick={() => setStep((s) => Math.min(TOTAL, s + 1))} disabled={!canNext[step]}>{t.common.next}</Button>
          ) : (
            <Button variant="primary" size="lg" onClick={publish} disabled={authStatus !== 'signed_in' || !file || !contentType || !rightsConfirmed}>{t.upload.publish}</Button>
          )}
        </div>
      </div>
    </div>
  );
}

function UploadStatus({ phase, onRetry, onTagsUpdated }: { phase: Exclude<Phase, { kind: 'edit' }>; onRetry?: () => void; onTagsUpdated: (v: VideoView) => void }) {
  const { t, fmt } = useI18n();
  if (phase.kind === 'error') {
    return (
      <div className="state state--error" role="alert">
        <h2 className="state__title">{t.videoStatus.failed}</h2>
        <p className="state__text">{phase.message}</p>
        {onRetry ? <div className="state__action"><Button onClick={onRetry}>{t.upload.retryUpload}</Button></div> : null}
      </div>
    );
  }
  const status: VideoStatus = phase.kind === 'sending' ? 'uploading' : phase.video.status;
  const bad = status === 'rejected' || status === 'failed' || status === 'deleted';
  const review = status === 'review_required';
  const order = TIMELINE.indexOf(status);
  const currentIdx = order >= 0 ? order : review ? 3 : 2;
  const rows: VideoStatus[] = bad ? [...TIMELINE.slice(0, 3), status] : review ? [...TIMELINE.slice(0, 3), 'review_required', 'published'] : TIMELINE;
  const statusText = (s: VideoStatus) => t.videoStatus[`${s}Text`];

  return (
    <div className="stack" aria-live="polite" data-testid="upload-status">
      <ol className="status-list">
        {rows.map((s, i) => {
          const isCurrent = s === status;
          const done = !isCurrent && (i < currentIdx || (review && i < 3) || (bad && i < 3));
          return (
            <li key={s} className={isCurrent ? (bad ? 'is-bad' : 'is-current') : done ? 'is-done' : ''} aria-current={isCurrent ? 'step' : undefined}>
              <Icon name={done ? 'check' : bad && isCurrent ? 'close' : isCurrent ? 'spark' : 'play'} size={20} />
              <div>
                <strong>{t.videoStatus[s]}</strong>
                {isCurrent ? <span className="small">{statusText(s)}</span> : null}
                {isCurrent && s === 'uploading' && phase.kind === 'sending' ? (
                  <div className="stack stack--tight" style={{ marginBlockStart: '0.5rem' }}>
                    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(phase.progress * 100)}>
                      <span style={{ inlineSize: `${Math.round(phase.progress * 100)}%` }} />
                    </div>
                    <span className="small muted">{fmt(t.upload.uploadProgress, { pct: Math.round(phase.progress * 100) })}</span>
                  </div>
                ) : null}
                {isCurrent && phase.kind === 'tracking' && phase.video.statusReason ? (
                  <p className="small">{fmt(t.videoStatus.reason, { reason: phase.video.statusReason })}</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {phase.kind === 'tracking' && ACTIVE_STATUSES.includes(status) ? <p className="small muted">{t.upload.stillWorking}</p> : null}
      {phase.kind === 'tracking' && (status === 'published' || review) && phase.video.tags.length ? (
        <div className="card">
          <h3 className="section-title" style={{ fontSize: '1.1rem' }}>{t.tags.title}</h3>
          <SkillTags tags={phase.video.tags} editable videoId={phase.video.id} onUpdated={onTagsUpdated} />
        </div>
      ) : null}
    </div>
  );
}
