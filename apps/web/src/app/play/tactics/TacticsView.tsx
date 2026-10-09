'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { XpCard } from '@/components/play/XpCard';
import { Arrow, ArrowMarkers, Ball, Dot, focusRange, optionLetter, PitchFrame, type ArrowTone } from '@/components/play/Pitch';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { SkeletonList } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toast';
import { XP_BEST } from '@fp/domain';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/provider';
import { useApi } from '@/lib/useApi';
import type { PlayAnswerFeedback, PlayProfile, PlayRoundView, PlayScenarioView } from '@/lib/types';

export function TacticsView() {
  const { t } = useI18n();
  return (
    <div className="wrap wrap--mid page">
      <div className="row">
        <Link href="/play" className="back-link"><Icon name="arrow" size={16} className="flip-rtl back-link__icon" />{t.play.backToPlay}</Link>
      </div>
      <AuthGate><Game /></AuthGate>
    </div>
  );
}

function Game() {
  const { t } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const roundId = params.get('round');
  const challengeId = params.get('challenge');
  const loaded = useApi((s) => (roundId ? api.round(roundId, s) : api.startRound(challengeId ? { challengeId } : {})), [roundId, challengeId]);

  // Keep the round in the address so a refresh resumes it instead of starting a new one.
  useEffect(() => {
    if (loaded.status === 'success' && !roundId) router.replace(`/play/tactics?round=${loaded.data.id}`);
  }, [loaded.status, loaded.data, roundId, router]);

  if (loaded.status === 'loading') return <SkeletonList rows={4} label={t.common.loading} />;
  if (loaded.status === 'error') return <ErrorState error={loaded.error} title={t.play.loadError} onRetry={loaded.retry} />;
  return <Round key={loaded.data.id} initial={loaded.data} />;
}

function Round({ initial }: { initial: PlayRoundView }) {
  const { t, fmt, pick } = useI18n();
  const toast = useToast();
  const [round, setRound] = useState(initial);
  const [profile, setProfile] = useState<PlayProfile | null>(null);
  const [showing, setShowing] = useState<PlayAnswerFeedback | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState(initial.completed);

  const answeredIds = new Set(round.answers.map((a) => a.scenarioId));
  const current: PlayScenarioView | undefined = showing
    ? round.scenarios.find((s) => s.id === showing.scenarioId)
    : round.scenarios.find((s) => !answeredIds.has(s.id));
  const index = current ? round.scenarios.indexOf(current) : round.scenarios.length - 1;

  const choose = async (optionId: string) => {
    if (!current || busy || showing) return;
    setBusy(true);
    try {
      const res = await api.answer(round.id, { scenarioId: current.id, optionId });
      setRound(res.round);
      setProfile(res.profile);
      setShowing(res.feedback);
    } catch (e) {
      toast.show(errorMessage(e, t), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const next = () => {
    setShowing(null);
    if (round.completed) setSummary(true);
  };

  if (summary || !current) return <Summary round={round} profile={profile} />;

  const verdict = showing ? (showing.points === 2 ? t.play.verdictBest : showing.points === 1 ? t.play.verdictGood : t.play.verdictPoor) : null;
  const bestIndex = showing ? current.options.findIndex((o) => o.id === showing.bestOptionId) : -1;

  return (
    <div className="tactics">
      <div className="tactics__head row row--between">
        <span className="kicker">{fmt(t.play.scenarioOf, { n: index + 1, total: round.scenarios.length })}</span>
        <span className="badge badge--outline">{t.play.topics[current.topic]}</span>
      </div>
      <div className="dots-progress" aria-hidden="true">
        {round.scenarios.map((s) => {
          const a = round.answers.find((x) => x.scenarioId === s.id);
          return <span key={s.id} className={a ? `is-${a.points === 2 ? 'best' : a.points === 1 ? 'good' : 'poor'}` : s.id === current.id ? 'is-current' : ''} />;
        })}
      </div>
      {!round.earnsXp && !round.completed ? <p className="notice">{t.play.practiceOnly}</p> : null}

      <div className="tactics__grid">
        <ScenarioPitch scenario={current} feedback={showing} />
        <div className="stack">
          <p className="tactics__prompt">{pick(current.prompt)}</p>
          <div className="stack stack--tight" role="group" aria-label={t.play.optionsLabel}>
            {current.options.map((o, i) => {
              const fb = showing?.options.find((x) => x.id === o.id);
              const chosen = showing?.chosenOptionId === o.id;
              const cls = !showing ? '' : fb?.points === 2 ? ' is-best' : chosen ? ' is-wrong' : ' is-dim';
              return (
                <button key={o.id} type="button" className={`option${cls}${chosen ? ' is-chosen' : ''}`} onClick={() => void choose(o.id)}
                  disabled={busy || Boolean(showing)} aria-pressed={chosen || undefined}>
                  <span className="option__letter">{optionLetter(i)}</span>
                  <span className="option__body">
                    <span className="option__label">{pick(o.label)}</span>
                    {fb ? <span className="option__why">{pick(fb.why)}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>

          {showing ? (
            <div className={`feedback feedback--${showing.points === 2 ? 'best' : showing.points === 1 ? 'good' : 'poor'}`} role="status">
              <div className="row row--between">
                <strong className="feedback__verdict">{verdict}</strong>
                {showing.xp ? <span className="badge badge--green">{fmt(t.play.xpGained, { n: showing.xp })}</span> : null}
              </div>
              {showing.points < 2 && bestIndex >= 0 ? (
                <p>{fmt(t.play.bestWas, { option: `${optionLetter(bestIndex)}. ${pick(current.options[bestIndex]!.label)}` })}</p>
              ) : null}
              {showing.points === 2 && showing.xp > XP_BEST ? <p className="muted">{t.play.fastBonus}</p> : null}
              <div className="feedback__lesson">
                <span className="kicker">{t.play.coachPoint}</span>
                <p>{pick(showing.lesson)}</p>
              </div>
              <Button variant="primary" onClick={next} autoFocus>{round.completed ? t.play.seeResults : t.play.next}</Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ScenarioPitch({ scenario, feedback }: { scenario: PlayScenarioView; feedback: PlayAnswerFeedback | null }) {
  const { t } = useI18n();
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const { pitch } = scenario;
  const toneFor = (optionId: string): ArrowTone => {
    if (!feedback) return 'idle';
    if (optionId === feedback.bestOptionId) return 'best';
    if (optionId === feedback.chosenOptionId) return 'chosen-wrong';
    return 'dim';
  };
  const ys = [pitch.you, pitch.ball, ...pitch.teammates, ...pitch.opponents, ...scenario.options.flatMap((o) => (o.arrow ? [o.arrow.to] : []))].map((p) => p.y);
  return (
    <figure className="tactics__pitch">
      <PitchFrame label={t.play.pitchLabel} focus={focusRange(ys)}>
        <ArrowMarkers id={id} />
        {pitch.opponents.map((p, i) => <Dot key={`o${i}`} p={p} kind="opp" n={p.n} />)}
        {pitch.teammates.map((p, i) => <Dot key={`t${i}`} p={p} kind="team" n={p.n} />)}
        <Dot p={pitch.you} kind="you" ring />
        <Ball p={pitch.ball} />
        {scenario.options.map((o, i) => (o.arrow ? <Arrow key={o.id} id={id} arrow={o.arrow} letter={optionLetter(i)} tone={toneFor(o.id)} /> : null))}
      </PitchFrame>
      <figcaption className="pitch-legend">
        <span><i className="lg lg--you" />{t.play.you}</span>
        <span><i className="lg lg--team" />{t.play.legendTeam}</span>
        <span><i className="lg lg--opp" />{t.play.legendOpp}</span>
        <span><i className="lg lg--ball" />{t.play.legendBall}</span>
      </figcaption>
    </figure>
  );
}

function Summary({ round, profile }: { round: PlayRoundView; profile: PlayProfile | null }) {
  const { t, fmt } = useI18n();
  const me = useApi((s) => api.playMe(s), [], { enabled: !profile });
  const ch = useApi((s) => api.playChallenges(s), [round.challengeId], { enabled: Boolean(round.challengeId) });
  const shown = profile ?? (me.status === 'success' ? me.data : null);
  const challenge = ch.status === 'success' ? ch.data.items.find((c) => c.id === round.challengeId) : undefined;
  return (
    <div className="stack stack--loose">
      <div className="card round-summary">
        <span className="kicker">{t.play.roundDone}</span>
        <div className="round-summary__score">{fmt(t.play.roundScore, { points: round.points, max: round.maxPoints })}</div>
        {round.xp ? <span className="badge badge--green">{fmt(t.play.roundXp, { n: round.xp })}</span> : null}
        {challenge && challenge.status !== 'completed' ? <p>{fmt(t.play.challengeSubmitted, { name: challenge.other.displayName })}</p> : null}
        <div className="row">
          {round.challengeId
            ? <ButtonLink href="/play/friends" variant="primary">{t.play.seeChallenges}</ButtonLink>
            : <ButtonLink href="/play/tactics" variant="primary">{t.play.playAgain}</ButtonLink>}
          <ButtonLink href="/play" variant="secondary">{t.play.backToPlay}</ButtonLink>
        </div>
      </div>
      {shown ? <XpCard profile={shown} /> : null}
    </div>
  );
}
