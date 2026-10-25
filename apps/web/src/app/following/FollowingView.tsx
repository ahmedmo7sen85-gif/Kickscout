'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Crest } from '@/components/football/Football';
import { PageHead, Section } from '@/components/PageHead';
import { Button, ButtonLink } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/errors';
import { useFavorites } from '@/lib/favorites';
import { useI18n } from '@/lib/i18n/provider';
import { currentSubscription, disablePush, enablePush, permission, pushSupport } from '@/lib/push';
import type { AlertCategory, AlertPreferencesView, CompetitionRef, FootballSearchView, PushConfigView, PushStatusView, TeamRef } from '@/lib/types';

const CATEGORIES: AlertCategory[] = ['starting_soon', 'kickoff', 'goal', 'halftime', 'final_result', 'lineups'];

function Favourites({ provider }: { provider: string }) {
  const { t, fmt } = useI18n();
  const toast = useToast();
  const fav = useFavorites();
  const remove = (kind: 'team' | 'competition', item: TeamRef | CompetitionRef) =>
    fav.toggle(kind, item, provider).catch((e) => toast.show(errorMessage(e, t), { tone: 'error' }));
  const row = (kind: 'team' | 'competition', item: TeamRef | CompetitionRef) => (
    <li key={`${kind}-${item.id}`} className="fav-row">
      <Crest url={item.logoUrl} />
      {kind === 'team'
        ? <Link className="link fav-row__name" href={`/scores/team/${encodeURIComponent(item.id!)}`}>{item.name}</Link>
        : <Link className="link fav-row__name" href={`/scores/competition/${encodeURIComponent(item.id!)}`}>{item.name}</Link>}
      <Button size="sm" variant="ghost" onClick={() => void remove(kind, item)} aria-label={fmt(t.football.unfollowName, { name: item.name })}>{t.football.remove}</Button>
    </li>
  );
  if (fav.mode === 'loading') return null;
  if (!fav.teams.length && !fav.competitions.length) return <p className="muted">{t.football.noFavorites}</p>;
  return (
    <div className="stack">
      {fav.teams.length ? <><h3 className="kicker">{t.football.teams}</h3><ul className="fav-list">{fav.teams.map((x) => row('team', x))}</ul></> : null}
      {fav.competitions.length ? <><h3 className="kicker">{t.football.competitions}</h3><ul className="fav-list">{fav.competitions.map((x) => row('competition', x))}</ul></> : null}
    </div>
  );
}

function Search({ provider }: { provider: string }) {
  const { t, fmt } = useI18n();
  const toast = useToast();
  const fav = useFavorites();
  const [q, setQ] = useState('');
  const [res, setRes] = useState<FootballSearchView | null>(null);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setRes(null); return; }
    const ctrl = new AbortController();
    const id = window.setTimeout(() => {
      api.footballSearch(term, ctrl.signal).then(setRes, (e) => { if (!ctrl.signal.aborted) toast.show(errorMessage(e, t), { tone: 'error' }); });
    }, 300);
    return () => { window.clearTimeout(id); ctrl.abort(); };
  }, [q, t, toast]);
  const toggle = (kind: 'team' | 'competition', item: TeamRef | CompetitionRef) =>
    fav.toggle(kind, item, provider).catch((e) => toast.show(errorMessage(e, t), { tone: 'error' }));
  const item = (kind: 'team' | 'competition', x: TeamRef | CompetitionRef) => {
    const on = fav.isFollowing(kind, x.id!);
    return (
      <li key={`${kind}-${x.id}`} className="fav-row">
        <Crest url={x.logoUrl} />
        <span className="fav-row__name">{x.name}<span className="muted small"> · {kind === 'team' ? t.football.teamPage : t.football.competitionPage}</span></span>
        <Button size="sm" variant={on ? 'primary' : 'secondary'} aria-pressed={on} onClick={() => void toggle(kind, x)}
          aria-label={fmt(on ? t.football.unfollowName : t.football.followName, { name: x.name })}>{on ? t.football.followingBtn : t.football.follow}</Button>
      </li>
    );
  };
  const empty = res && !res.teams.length && !res.competitions.length;
  return (
    <div className="stack">
      <label className="stack stack--tight">
        <span>{t.football.searchLabel}</span>
        <input className="input" type="search" value={q} maxLength={60} placeholder={t.football.searchPlaceholder} onChange={(e) => setQ(e.target.value)} />
      </label>
      <p className="small muted">{t.football.searchHint}</p>
      <div aria-live="polite">
        {empty ? <p className="muted">{fmt(t.football.noResults, { q: q.trim() })}</p> : null}
        {res && !empty ? (
          <ul className="fav-list">
            {res.teams.filter((x) => x.id).map((x) => item('team', x))}
            {res.competitions.filter((x) => x.id).map((x) => item('competition', x))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function Alerts() {
  const { t, fmt, locale } = useI18n();
  const toast = useToast();
  const fav = useFavorites();
  const [prefs, setPrefs] = useState<AlertPreferencesView | null>(null);
  const [config, setConfig] = useState<PushConfigView | null>(null);
  const [status, setStatus] = useState<PushStatusView | null>(null);
  const [support, setSupport] = useState<ReturnType<typeof pushSupport> | null>(null);
  const [perm, setPerm] = useState<ReturnType<typeof permission>>('default');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSupport(pushSupport());
    setPerm(permission());
    api.alertPreferences().then(setPrefs, () => setPrefs(null));
    api.pushConfig().then(setConfig, () => setConfig({ available: false, publicKey: null }));
    void currentSubscription().then((s) => (s ? api.pushStatus(s.endpoint).then(setStatus) : setStatus({ registered: false, devices: 0 }))).catch(() => undefined);
  }, []);

  const save = async (patch: Parameters<typeof api.updateAlertPreferences>[0]) => {
    try { setPrefs(await api.updateAlertPreferences(patch)); } catch (e) { toast.show(errorMessage(e, t), { tone: 'error' }); }
  };
  const turnOn = async () => {
    if (!config?.publicKey) return;
    setBusy(true);
    try {
      const r = await enablePush(config.publicKey);
      setPerm(permission());
      if (!r.ok) { toast.show(r.reason === 'denied' ? t.football.pushDenied : r.reason === 'unsupported' ? t.football.pushUnsupported : t.errors.INTERNAL, { tone: 'error' }); return; }
      const keys = r.subscription.keys ?? {};
      setStatus(await api.pushSubscribe({ endpoint: r.subscription.endpoint!, keys: { p256dh: keys.p256dh ?? '', auth: keys.auth ?? '' }, locale }));
      if (prefs && !prefs.enabled) await save({ enabled: true });
    } catch (e) {
      toast.show(errorMessage(e, t), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const turnOff = async () => {
    setBusy(true);
    try {
      const endpoint = await disablePush();
      setStatus(endpoint ? await api.pushRemove(endpoint) : { registered: false, devices: status?.devices ?? 0 });
    } catch (e) {
      toast.show(errorMessage(e, t), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    try {
      const r = await api.pushTest();
      toast.show(r.sent ? t.football.pushTestSent : t.football.pushTestNone, { tone: r.sent ? 'success' : 'error' });
    } catch (e) {
      toast.show(errorMessage(e, t), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  if (!prefs || !config || support === null) return null;
  const nothingFollowed = !fav.teams.length && !fav.competitions.length;
  return (
    <div className="stack">
      <p className="muted">{t.football.alertsIntro}</p>
      {!config.available ? <p className="notice" role="note">{t.football.pushNotConfigured}</p>
        : support !== 'supported' ? <p className="notice" role="note">{t.football.pushUnsupported}</p>
        : perm === 'denied' ? <p className="notice notice--warn" role="note">{t.football.pushDenied}</p>
        : (
          <div className="stack stack--tight">
            <p className="small" role="status">{status?.registered ? t.football.pushActive : t.football.pushInactive}
              {status && status.devices > 0 ? <span className="muted"> · {fmt(t.football.pushDevices, { n: status.devices })}</span> : null}</p>
            {!status?.registered ? <p className="small muted">{t.football.pushExplain}</p> : null}
            <div className="row">
              {status?.registered
                ? <><Button size="sm" onClick={() => void test()} disabled={busy}>{t.football.pushTest}</Button><Button size="sm" variant="ghost" onClick={() => void turnOff()} disabled={busy}>{t.football.pushDisable}</Button></>
                : <Button variant="primary" onClick={() => void turnOn()} loading={busy}>{t.football.pushEnable}</Button>}
            </div>
          </div>
        )}
      <label className="check">
        <input type="checkbox" checked={prefs.enabled} onChange={(e) => void save({ enabled: e.target.checked })} />
        <span>{t.football.alertsToggle}</span>
      </label>
      <fieldset className="stack stack--tight" disabled={!prefs.enabled}>
        <legend className="kicker">{t.football.categoriesLabel}</legend>
        {CATEGORIES.map((c) => {
          const unsupported = prefs.unsupported.includes(c);
          return (
            <label key={c} className="check">
              <input type="checkbox" disabled={unsupported} checked={!unsupported && Boolean(prefs.categories[c])} onChange={(e) => void save({ categories: { [c]: e.target.checked } })} />
              <span>{t.football.category[c]}{unsupported ? <span className="muted small"> ({t.football.categoryUnsupported})</span> : null}</span>
            </label>
          );
        })}
      </fieldset>
      {nothingFollowed ? <p className="small muted">{t.football.needFollow}</p> : null}
      <p className="small muted">{t.football.deliveryNote}</p>
    </div>
  );
}

export function FollowingView() {
  const { t } = useI18n();
  const { status, me } = useAuth();
  const fav = useFavorites();
  const signedIn = status === 'signed_in' && Boolean(me);
  // Device-local favourites are tied to the data source in use; null until the server says which.
  const [provider, setProvider] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    api.footballStatus().then((s) => setProvider(s.source?.provider ?? null), () => setProvider(null));
  }, []);
  return (
    <div className="wrap wrap--mid page">
      <PageHead title={t.football.followingTitle} intro={t.football.followingIntro}
        actions={<ButtonLink href="/scores" size="sm">{t.football.scoresTitle}</ButtonLink>} />
      {fav.mode === 'local' ? (
        <p className="notice" role="note"><span>{t.football.localOnly}</span> {!signedIn ? <Link className="link" href="/signup">{t.common.signUp}</Link> : null}</p>
      ) : null}
      <Section title={t.football.followingTitle} id="favourites">{provider ? <Favourites provider={provider} /> : provider === null ? <p className="muted">{t.football.disabledText}</p> : null}</Section>
      {provider ? <Section title={t.football.searchLabel} id="search"><Search provider={provider} /></Section> : null}
      <Section title={t.football.alertsTitle} id="alerts">
        {signedIn ? <Alerts /> : <p className="muted">{t.football.alertsSignIn} <Link className="link" href="/login">{t.common.logIn}</Link></p>}
      </Section>
    </div>
  );
}
