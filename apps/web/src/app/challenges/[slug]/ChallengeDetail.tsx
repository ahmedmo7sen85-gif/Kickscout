'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { trackClient } from '@/components/Analytics';
import { PageHead, Section } from '@/components/PageHead';
import { DemoBadge, VerifiedBadge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { Skeleton, SkeletonGrid, SkeletonList } from '@/components/ui/Skeleton';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { Tabs } from '@/components/ui/Tabs';
import { useToast } from '@/components/ui/Toast';
import { SkillChip } from '@/components/video/SkillChip';
import { VideoCard } from '@/components/video/VideoCard';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import type { Dict } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/provider';
import { absoluteUrl, shareLink } from '@/lib/share';
import type { ChallengeDetailView, LeaderboardEntry, MySubmissionView, ScoreView } from '@/lib/types';
import { useApi } from '@/lib/useApi';

type Unit = ScoreView['unit'];

/** A score as people read it: times in seconds, everything else as a count of the rubric's unit. */
export function formatScore(value: number, unit: Unit, t: Dict, formatNumber: (n: number) => string): string {
  if (unit === 'ms') return `${formatNumber(Math.round(value / 10) / 100)} s`;
  return `${formatNumber(value)} ${t.challenges.units[unit]}`;
}

/** The reason a player may not enter, in their language when we know the code. */
function eligibilityText(code: string | null, reason: string | null, t: Dict): string {
  const known = code ? (t.errors as Record<string, string>)[code] : undefined;
  return known ?? reason ?? t.errors.genericText;
}

export function ChallengeDetail({ slug }: { slug: string }) {
  const { t, fmt, pick, formatDate, formatNumber } = useI18n();
  const c = useApi((s) => api.challenge(slug, s), [slug]);

  if (c.status === 'loading') return <div className="wrap page" role="status" aria-label={t.common.loading}><Skeleton width="60%" height="3rem" /><SkeletonList rows={2} label={t.common.loading} /></div>;
  if (c.status === 'error') {
    return (
      <div className="wrap page">
        {c.error.status === 404 ? <EmptyState icon="trophy" title={t.challenges.notFound} action={<ButtonLink href="/challenges">{t.challenges.title}</ButtonLink>} />
          : <ErrorState error={c.error} title={t.challenges.errorTitle} onRetry={c.retry} />}
      </div>
    );
  }
  const ch = c.data;
  const live = ch.phase === 'open';

  return (
    <div className="wrap page">
      <PageHead
        kicker={(
          <span className="row">
            <span className={`badge ${live ? 'badge--green' : 'badge--outline'}`}>{t.challenges.phases[ch.phase]}</span>
            <span className="badge badge--outline">{t.challenges.difficulties[ch.difficulty]}</span>
            <span className="badge badge--outline">{t.challenges.categories[ch.category]}</span>
            {ch.format !== 'standard' ? <span className="badge badge--outline">{t.challenges.formats[ch.format]}</span> : null}
            {ch.isDemo ? <DemoBadge /> : null}
          </span>
        )}
        title={pick(ch.title)}
        intro={pick(ch.description)}
      />
      <div className="row">
        {ch.hashtag ? <span className="chip chip--hashtag" dir="auto">#{ch.hashtag}</span> : null}
        {ch.skill ? <SkillChip skill={ch.skill} /> : null}
        <span className="muted small">
          {fmt(t.challenges.dates, { start: formatDate(ch.startsAt), end: formatDate(ch.endsAt) })}
          {' · '}{fmt(t.challenges.participants, { n: formatNumber(ch.participants) })}
          {' · '}{fmt(t.challenges.entries, { n: formatNumber(ch.entries) })}
        </span>
      </div>
      {ch.reward ? <p className="small" dir="auto">{pick(ch.reward)}</p> : null}
      <p className="small muted">{t.challenges.noCash}</p>

      <Participate ch={ch} onChange={c.retry} />
      {ch.me && ch.me.submissions.length ? <MyEntries ch={ch} items={ch.me.submissions} onChange={c.retry} /> : null}
      <HowTo ch={ch} />
      <Scoring ch={ch} />
      {ch.phase === 'completed' ? <Results slug={slug} unit={ch.rubric?.unit ?? 'points'} /> : null}
      {ch.rubric ? <Leaderboard ch={ch} onVoted={c.setData} /> : null}
      <Entries slug={slug} />
    </div>
  );
}

// ---------------------------------------------------------------- join, submit, invite

function Participate({ ch, onChange }: { ch: ChallengeDetailView; onChange: () => void }) {
  const { t, fmt, pick } = useI18n();
  const { status, me } = useAuth();
  const toast = useToast();
  const params = useSearchParams();
  const ref = params.get('ref') ?? undefined;
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const live = ch.phase === 'open';
  const uploadHref = `/upload?challenge=${encodeURIComponent(ch.id)}&slug=${encodeURIComponent(ch.slug)}`;

  const invite = async () => {
    const path = me ? `/challenges/${ch.slug}?ref=${encodeURIComponent(me.profile.handle)}` : `/challenges/${ch.slug}`;
    const r = await shareLink(absoluteUrl(path), pick(ch.title), fmt(t.challenges.shareText, { title: pick(ch.title) }));
    if (r === 'copied') toast.show(t.challenges.linkCopied, { tone: 'success' });
    if (r === 'shared' || r === 'copied') trackClient('challenge_shared', { challengeId: ch.id, kind: 'invite' });
  };

  const join = async () => {
    setBusy(true);
    try {
      await api.joinChallenge(ch.slug, { ref: ref && /^[a-zA-Z0-9_.]{3,30}$/.test(ref) ? ref : undefined, safetyAck: ack });
      toast.show(t.challenges.joined, { tone: 'success' });
      onChange();
    } catch (e) {
      toast.show(errorMessage(e, t), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const m = ch.me;
  const needsAck = ch.needsSafetyAck && !(m?.joined);
  return (
    <section className="card stack" aria-label={t.challenges.join}>
      {live && status !== 'signed_in' ? <p className="muted">{t.challenges.loginToJoin} <Link className="link" href="/login">{t.common.logIn}</Link></p> : null}
      {live && m && !m.eligibility.allowed ? <p className="notice notice--warn">{eligibilityText(m.eligibility.code, m.eligibility.reason, t)}</p> : null}
      {live && m && m.eligibility.allowed ? (
        <>
          <p className="small muted">{fmt(t.challenges.attempts, { used: m.attemptsUsed, limit: ch.attemptLimit })}{ch.retryFailed ? ` · ${t.challenges.retryNote}` : ''}</p>
          {!m.joined ? (
            <>
              {needsAck ? (
                <label className={`check-row${ack ? ' is-checked' : ''}`}>
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  <span>{t.challenges.safetyAck}</span>
                </label>
              ) : null}
              <div className="cta-row"><Button variant="primary" loading={busy} disabled={needsAck && !ack} onClick={join}>{t.challenges.join}</Button></div>
            </>
          ) : (
            <div className="cta-row">
              {m.attemptsLeft > 0 ? <ButtonLink href={uploadHref} variant="primary">{t.challenges.submitNew}</ButtonLink> : null}
              {m.attemptsLeft > 0 ? <Button onClick={() => setOpen(true)}>{t.challenges.enterExisting}</Button> : null}
            </div>
          )}
        </>
      ) : null}
      <div className="cta-row">
        <Button variant="ghost" onClick={invite}>{t.challenges.invite}</Button>
        {status === 'signed_in' ? <ButtonLink href="/challenges/mine" variant="ghost">{t.challenges.myChallenges}</ButtonLink> : null}
      </div>
      {open ? <EnterExisting ch={ch} onClose={() => setOpen(false)} onDone={() => { setOpen(false); onChange(); }} /> : null}
    </section>
  );
}

/** Enter a clip the player already published during the challenge window. */
function EnterExisting({ ch, onClose, onDone }: { ch: ChallengeDetailView; onClose: () => void; onDone: () => void }) {
  const { t, fmt } = useI18n();
  const toast = useToast();
  const mine = useApi((s) => api.myVideos(undefined, s), []);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [claimed, setClaimed] = useState('');
  const [others, setOthers] = useState(ch.requiresPartner);
  const [consent, setConsent] = useState(false);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const ready = !!videoId && (!ch.needsSafetyAck || ack) && (!others || consent);

  const submit = async () => {
    if (!videoId) return;
    setBusy(true);
    try {
      const n = claimed.trim() === '' ? undefined : Number(claimed);
      await api.enterChallenge(ch.slug, {
        videoId, claimedValue: n !== undefined && Number.isFinite(n) ? n : undefined, othersInClip: others, consentOthers: consent, safetyAck: ack,
      });
      toast.show(t.challenges.entrySubmitted, { tone: 'success' });
      onDone();
    } catch (e) {
      toast.show(errorMessage(e, t), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const eligible = mine.status === 'success'
    ? mine.data.items.filter((v) => v.status === 'published' && new Date(v.createdAt) >= new Date(ch.startsAt))
    : [];
  return (
    <Sheet open onClose={onClose} title={t.challenges.enterTitle} size="lg"
      footer={<Button variant="primary" block loading={busy} disabled={!ready} onClick={submit}>{t.common.submit}</Button>}>
      {mine.status === 'loading' ? <SkeletonList rows={3} label={t.common.loading} /> : null}
      {mine.status === 'error' ? <ErrorState error={mine.error} onRetry={mine.retry} /> : null}
      {mine.status === 'success' && !eligible.length ? <EmptyState icon="play" title={t.challenges.noVideos} /> : null}
      {eligible.length ? (
        <div className="stack">
          <p className="muted small">{t.challenges.pickVideo}</p>
          <ul className="list" role="radiogroup" aria-label={t.challenges.pickVideo}>
            {eligible.map((v) => (
              <li key={v.id} className="list__row">
                <label className="check-row" style={{ flex: 1 }}>
                  <input type="radio" name="clip" checked={videoId === v.id} onChange={() => setVideoId(v.id)} />
                  <span dir="auto">{v.title}</span>
                </label>
              </li>
            ))}
          </ul>
          {ch.rubric?.method === 'measured' ? (
            <label className="field">
              <span className="field__label">{fmt(t.challenges.claimedLabel, { unit: t.challenges.units[ch.rubric.unit] })}</span>
              <input className="input" type="number" inputMode="numeric" min={0} step="any" value={claimed} onChange={(e) => setClaimed(e.target.value)} />
              <span className="field__hint">{t.challenges.claimedHint}</span>
            </label>
          ) : null}
          {!ch.requiresPartner ? (
            <label className={`check-row${others ? ' is-checked' : ''}`}>
              <input type="checkbox" checked={others} onChange={(e) => setOthers(e.target.checked)} /><span>{t.challenges.othersInClip}</span>
            </label>
          ) : null}
          {others ? (
            <label className={`check-row${consent ? ' is-checked' : ''}`}>
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /><span>{t.challenges.consentOthers}</span>
            </label>
          ) : null}
          {ch.needsSafetyAck ? (
            <label className={`check-row${ack ? ' is-checked' : ''}`}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /><span>{t.challenges.safetyAck}</span>
            </label>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}

// ---------------------------------------------------------------- my entries

export function SubmissionRow({ s, onChange, showChallenge }: { s: MySubmissionView; onChange: () => void; showChallenge?: boolean }) {
  const { t, fmt, pick, formatDate, formatNumber } = useI18n();
  const toast = useToast();
  const [appealing, setAppealing] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const tone = s.state === 'approved' ? 'badge--green' : 'badge--outline';

  const withdraw = async () => {
    if (!window.confirm(t.challenges.withdrawConfirm)) return;
    setBusy(true);
    try {
      await api.withdrawEntry(s.id);
      toast.show(t.challenges.withdrawn, { tone: 'success' });
      onChange();
    } catch (e) { toast.show(errorMessage(e, t), { tone: 'error' }); } finally { setBusy(false); }
  };
  const appeal = async () => {
    setBusy(true);
    try {
      await api.appealEntry(s.id, reason.trim());
      toast.show(t.challenges.appealSent, { tone: 'success' });
      setAppealing(false);
      onChange();
    } catch (e) { toast.show(errorMessage(e, t), { tone: 'error' }); } finally { setBusy(false); }
  };

  return (
    <li className="list__row" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
      <div className="stack stack--tight" style={{ flex: 1, minInlineSize: '12rem' }}>
        <span className="row">
          <span className={`badge ${tone}`}>{t.challenges.states[s.state]}</span>
          {showChallenge ? <Link className="link" href={`/challenges/${s.challenge.slug}`}>{pick(s.challenge.title)}</Link> : <span className="small muted">#{s.attemptNo}</span>}
          <time className="small muted" dateTime={s.createdAt}>{formatDate(s.createdAt)}</time>
        </span>
        {s.score ? (
          <span>
            <strong>{formatScore(s.score.value, s.score.unit, t, formatNumber)}</strong>
            {s.rank ? <span className="small muted"> · {fmt(t.challenges.yourRank, { rank: s.rank })}</span> : null}
          </span>
        ) : null}
        {s.stateReason && (s.state === 'rejected' || s.state === 'disqualified' || s.state === 'failed_processing') ? <span className="small muted" dir="auto">{s.stateReason}</span> : null}
        {s.appeal ? <span className="small">{t.challenges.appealStatus[s.appeal.status]}{s.appeal.resolution ? `: ${s.appeal.resolution}` : ''}</span> : null}
      </div>
      <div className="row">
        <Link className="btn btn--ghost btn--sm" href={`/v/${s.videoId}`}>{t.upload.viewVideo}</Link>
        {s.canAppeal ? <Button size="sm" onClick={() => setAppealing(true)}>{t.challenges.appeal}</Button> : null}
        {s.canWithdraw ? <Button size="sm" variant="ghost" loading={busy && !appealing} onClick={withdraw}>{t.challenges.withdraw}</Button> : null}
      </div>
      <Sheet open={appealing} onClose={() => setAppealing(false)} title={t.challenges.appealTitle}
        footer={<Button variant="primary" block loading={busy} disabled={reason.trim().length < 10} onClick={appeal}>{t.common.submit}</Button>}>
        <label className="field">
          <span className="field__label">{t.challenges.appealReason}</span>
          <textarea className="input" rows={4} maxLength={1000} dir="auto" value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      </Sheet>
    </li>
  );
}

function MyEntries({ ch, items, onChange }: { ch: ChallengeDetailView; items: MySubmissionView[]; onChange: () => void }) {
  const { t, fmt, pick } = useI18n();
  const toast = useToast();
  const best = items.find((s) => s.rank !== null);
  const shareResult = async () => {
    if (!best?.rank) return;
    const r = await shareLink(absoluteUrl(`/challenges/${ch.slug}`), pick(ch.title), fmt(t.challenges.resultShare, { rank: best.rank, title: pick(ch.title) }));
    if (r === 'copied') toast.show(t.challenges.linkCopied, { tone: 'success' });
    if (r === 'shared' || r === 'copied') trackClient('challenge_shared', { challengeId: ch.id, kind: 'result' });
  };
  return (
    <Section title={t.challenges.yourEntries} id="my-entries" action={best?.rank ? <Button size="sm" variant="ghost" onClick={shareResult}>{t.challenges.shareResult}</Button> : undefined}>
      <ul className="list">{items.map((s) => <SubmissionRow key={s.id} s={s} onChange={onChange} />)}</ul>
    </Section>
  );
}

// ---------------------------------------------------------------- rules and scoring

function HowTo({ ch }: { ch: ChallengeDetailView }) {
  const { t, fmt, pick } = useI18n();
  const r = ch.recording;
  return (
    <Section title={t.challenges.howTo} id="how-to">
      <div className="stack">
        {pick(ch.instructions) ? <p dir="auto" style={{ whiteSpace: 'pre-line' }}>{pick(ch.instructions)}</p> : null}
        {ch.demoVideo ? <div className="grid-cards"><VideoCard video={ch.demoVideo} /></div> : null}
        {ch.equipment.length ? (
          <div>
            <h3 className="field__label">{t.challenges.equipment}</h3>
            <ul>{ch.equipment.map((e, i) => <li key={i} dir="auto">{pick(e)}</li>)}</ul>
          </div>
        ) : null}
        <div>
          <h3 className="field__label">{t.challenges.recording}</h3>
          <ul>
            <li>{t.challenges.cameras[r.camera]}</li>
            <li>{t.challenges.orientations[r.orientation]}</li>
            {r.continuousTake ? <li>{t.challenges.continuous}</li> : null}
            <li>{fmt(t.challenges.duration, { min: ch.minDurationS, max: ch.maxDurationS })}</li>
            {r.notes && pick(r.notes) ? <li dir="auto">{pick(r.notes)}</li> : null}
          </ul>
        </div>
        {ch.safetyNotes && pick(ch.safetyNotes) ? (
          <div className="notice notice--warn">
            <strong>{t.challenges.safety}</strong>
            <p dir="auto">{pick(ch.safetyNotes)}</p>
          </div>
        ) : null}
        {ch.rules.length ? (
          <div>
            <h3 className="field__label">{t.challenges.rules}</h3>
            <ul>{ch.rules.map((x, i) => <li key={i} dir="auto"><span className="muted small">{t.challenges.ruleKinds[x.kind]}: </span>{pick(x.body)}</li>)}</ul>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

function Scoring({ ch }: { ch: ChallengeDetailView }) {
  const { t, fmt, pick } = useI18n();
  const r = ch.rubric;
  if (!r) return null;
  return (
    <Section title={t.challenges.scoring} id="scoring">
      <div className="stack stack--tight">
        <p dir="auto">{pick(r.summary)}</p>
        <ul>{r.components.map((c) => <li key={c.key} dir="auto">{pick(c.label)}{c.weight !== undefined && r.method === 'judged' ? ` (${Math.round(c.weight * 100)}%)` : ''}</li>)}</ul>
        <p className="small muted">{t.challenges.judgesNote}</p>
        {r.frozen ? <p className="small muted">{fmt(t.challenges.rubricVersion, { n: r.version })}</p> : null}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- leaderboard and results

function PlayerCell({ e }: { e: LeaderboardEntry }) {
  return (
    <span className="row" style={{ gap: '0.35rem' }}>
      <Link className="link" href={`/u/${encodeURIComponent(e.player.handle)}`} dir="auto">{e.player.displayName}</Link>
      {e.player.verified ? <VerifiedBadge compact /> : null}
      {e.player.isDemo ? <DemoBadge /> : null}
      {e.country ? <span className="small muted">{e.country}</span> : null}
    </span>
  );
}

function Leaderboard({ ch, onVoted }: { ch: ChallengeDetailView; onVoted: (fn: (d: ChallengeDetailView) => ChallengeDetailView) => void }) {
  const { t, fmt, formatNumber, formatDate } = useI18n();
  const { me, status, isScout } = useAuth();
  const toast = useToast();
  const country = me?.profile.region.country ?? null;
  const [scope, setScope] = useState<'overall' | 'country'>('overall');
  const board = useApi((s) => api.challengeLeaderboard(ch.slug, { scope: scope === 'country' && country ? country : 'overall' }, s), [ch.slug, scope, country]);
  const [busy, setBusy] = useState<string | null>(null);
  const votingOpen = ch.votingEnabled && (ch.phase === 'open' || ch.phase === 'judging') && status === 'signed_in' && !!ch.me;
  const canPick = isScout && (ch.phase === 'open' || ch.phase === 'judging' || ch.phase === 'completed');

  const vote = async (e: LeaderboardEntry, on: boolean) => {
    setBusy(e.submissionId);
    try {
      const r = await api.voteEntry(e.submissionId, on);
      onVoted((d) => d.me ? { ...d, me: { ...d.me, votesLeft: r.votesLeft, votedFor: on ? [...d.me.votedFor, e.submissionId] : d.me.votedFor.filter((x) => x !== e.submissionId) } } : d);
      if (on && !r.counted) toast.show(t.challenges.voteNotCounted);
    } catch (err) { toast.show(errorMessage(err, t), { tone: 'error' }); } finally { setBusy(null); }
  };
  const pickEntry = async (e: LeaderboardEntry) => {
    setBusy(e.submissionId);
    try {
      await api.scoutPick(ch.slug, e.submissionId);
      toast.show(t.challenges.picked, { tone: 'success' });
    } catch (err) { toast.show(errorMessage(err, t), { tone: 'error' }); } finally { setBusy(null); }
  };

  const tabs = [{ id: 'overall' as const, label: t.challenges.overall }, ...(country ? [{ id: 'country' as const, label: `${t.challenges.country} · ${country}` }] : [])];
  return (
    <Section title={t.challenges.leaderboard} id="leaderboard">
      {tabs.length > 1 ? <Tabs items={tabs} active={scope} onChange={setScope} label={t.challenges.leaderboard} /> : null}
      {scope === 'country' ? <p className="small muted">{t.challenges.countryNote}</p> : null}
      {board.status === 'loading' ? <SkeletonList rows={5} label={t.common.loading} /> : null}
      {board.status === 'error' ? <ErrorState error={board.error} onRetry={board.retry} /> : null}
      {board.status === 'success' ? (
        <>
          <p className="small muted">{board.data.kind === 'final' ? t.challenges.finalBoard : t.challenges.liveBoard} · <time dateTime={board.data.computedAt}>{formatDate(board.data.computedAt)}</time></p>
          {votingOpen && ch.me ? <p className="small muted">{fmt(t.challenges.votesLeft, { n: ch.me.votesLeft })} · {t.challenges.votingNote}</p> : null}
          {!board.data.entries.length ? <EmptyState icon="trophy" title={t.challenges.noRanked} /> : (
            <div className="table-wrap">
              <table>
                <tbody>
                  {board.data.entries.map((e) => {
                    const voted = ch.me?.votedFor.includes(e.submissionId) ?? false;
                    const mine = board.data.me?.submissionId === e.submissionId;
                    return (
                      <tr key={e.submissionId} aria-current={mine ? 'true' : undefined}>
                        <td className="mono">#{e.rank}</td>
                        <td><PlayerCell e={e} />{mine ? <span className="badge badge--green" style={{ marginInlineStart: '0.4rem' }}>{t.challenges.you}</span> : null}</td>
                        <td><strong>{formatScore(e.value, board.data.unit, t, formatNumber)}</strong></td>
                        <td>
                          <span className="row" style={{ justifyContent: 'flex-end' }}>
                            <Link className="btn btn--ghost btn--sm" href={`/v/${e.videoId}`}>{t.challenges.watchClip}</Link>
                            {votingOpen && !mine ? (
                              <Button size="sm" variant={voted ? 'primary' : 'secondary'} aria-pressed={voted} loading={busy === e.submissionId}
                                disabled={!voted && (ch.me?.votesLeft ?? 0) <= 0} onClick={() => vote(e, !voted)}>{voted ? t.challenges.voted : t.challenges.vote}</Button>
                            ) : null}
                            {canPick ? <Button size="sm" variant="ghost" loading={busy === e.submissionId} onClick={() => pickEntry(e)}>{t.challenges.pick}</Button> : null}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {board.data.me && !board.data.entries.some((e) => e.submissionId === board.data.me?.submissionId) ? (
            <p className="small">{fmt(t.challenges.yourRank, { rank: board.data.me.rank })} · {formatScore(board.data.me.value, board.data.unit, t, formatNumber)}</p>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}

function Results({ slug, unit }: { slug: string; unit: Unit }) {
  const { t, fmt, formatNumber } = useI18n();
  const r = useApi((s) => api.challengeResults(slug, s), [slug]);
  if (r.status === 'loading') return <SkeletonList rows={3} label={t.common.loading} />;
  if (r.status === 'error') return <ErrorState error={r.error} onRetry={r.retry} />;
  const d = r.data;
  if (!d.published) return <p className="notice">{t.challenges.resultsPending}</p>;
  return (
    <Section title={t.challenges.finalBoard} id="results">
      <div className="stack">
        {d.podium.length ? (
          <div>
            <h3 className="field__label">{t.challenges.podium}</h3>
            <ol className="list">{d.podium.map((e) => <li key={e.submissionId} className="list__row"><span className="mono">#{e.rank}</span><PlayerCell e={e} /><strong>{formatScore(e.value, unit, t, formatNumber)}</strong></li>)}</ol>
          </div>
        ) : <p className="muted">{t.challenges.noRanked}</p>}
        {d.communityFavorite ? (
          <div>
            <h3 className="field__label">{t.challenges.communityFavorite}</h3>
            <div className="list__row"><PlayerCell e={d.communityFavorite} /><span className="small muted">{fmt(t.challenges.votes, { n: formatNumber(d.communityFavorite.votes) })}</span></div>
          </div>
        ) : null}
        {d.scoutPicks.length ? (
          <div>
            <h3 className="field__label">{t.challenges.scoutPicks}</h3>
            <ul className="list">{d.scoutPicks.map((e) => <li key={e.submissionId} className="list__row"><PlayerCell e={e} /></li>)}</ul>
          </div>
        ) : null}
        <p className="small muted">{fmt(t.challenges.participants, { n: formatNumber(d.participants) })} · {fmt(t.challenges.entries, { n: formatNumber(d.approvedEntries) })}</p>
      </div>
    </Section>
  );
}

function Entries({ slug }: { slug: string }) {
  const { t } = useI18n();
  const entries = useApi((s) => api.challengeEntries(slug, undefined, s), [slug]);
  return (
    <Section title={t.challenges.entriesTitle} id="entries">
      {entries.status === 'loading' ? <SkeletonGrid count={4} label={t.common.loading} /> : null}
      {entries.status === 'error' ? <ErrorState error={entries.error} onRetry={entries.retry} /> : null}
      {entries.status === 'success' && entries.data.items.length === 0 ? <EmptyState icon="trophy" title={t.challenges.entriesEmpty} /> : null}
      {entries.status === 'success' && entries.data.items.length > 0 ? (
        <div className="grid-cards">{entries.data.items.map((v) => <VideoCard key={v.id} video={v} />)}</div>
      ) : null}
    </Section>
  );
}
