'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { EMPTY_LOCAL, readLocalFavorites, safeStorage, toggleLocal, writeLocalFavorites, type LocalFavorites } from './football';
import type { CompetitionRef, TeamRef } from './types';

type Kind = 'team' | 'competition';

interface FavoritesValue {
  /** `local`: saved on this device only (signed out). `account`: saved to the account. */
  mode: 'loading' | 'local' | 'account';
  teams: TeamRef[];
  competitions: CompetitionRef[];
  teamIds: Set<string>;
  competitionIds: Set<string>;
  isFollowing: (kind: Kind, id: string) => boolean;
  /** Adds or removes; resolves when saved. Throws the API error when the account save fails. */
  toggle: (kind: Kind, item: TeamRef | CompetitionRef, provider: string) => Promise<void>;
}

const Ctx = createContext<FavoritesValue | null>(null);

/**
 * Favourite teams and competitions for the whole app. Signed out, they live in this browser so
 * people can try the feature without an account; after sign-in they are imported into the account
 * once (the server ignores unknown ids and merges duplicates) and the local copy is cleared.
 */
export function FavoritesProvider({ children }: { children: ReactNode }) {
  const { status, me } = useAuth();
  const [mode, setMode] = useState<FavoritesValue['mode']>('loading');
  const [data, setData] = useState<LocalFavorites>(EMPTY_LOCAL);

  useEffect(() => {
    let alive = true;
    if (status === 'loading') return;
    if (status !== 'signed_in' || !me) {
      setData(readLocalFavorites(safeStorage()));
      setMode('local');
      return;
    }
    const local = readLocalFavorites(safeStorage());
    const load = local.teams.length || local.competitions.length
      ? api.importFavorites({ teams: local.teams.map((t) => t.id), competitions: local.competitions.map((c) => c.id).filter((c): c is string => Boolean(c)) })
        .then((r) => { writeLocalFavorites(safeStorage(), EMPTY_LOCAL); return r; })
      : api.favorites();
    load.then(
      (r) => { if (alive) { setData({ provider: r.provider, teams: r.teams, competitions: r.competitions }); setMode('account'); } },
      () => { if (alive) { setData(local); setMode('local'); } },
    );
    return () => { alive = false; };
  }, [status, me]);

  const toggle = useCallback(async (kind: Kind, item: TeamRef | CompetitionRef, provider: string) => {
    if (!item.id) return;
    if (mode !== 'account') {
      setData((d) => {
        const next = toggleLocal(d, kind, item, provider);
        writeLocalFavorites(safeStorage(), next);
        return next;
      });
      return;
    }
    const following = (kind === 'team' ? data.teams : data.competitions).some((x) => x.id === item.id);
    const id = item.id;
    const r = kind === 'team'
      ? await (following ? api.unfollowTeam(id) : api.followTeam(id))
      : await (following ? api.unfollowCompetition(id) : api.followCompetition(id));
    setData({ provider: r.provider, teams: r.teams, competitions: r.competitions });
  }, [mode, data]);

  const value = useMemo<FavoritesValue>(() => {
    const teamIds = new Set(data.teams.map((t) => t.id));
    const competitionIds = new Set(data.competitions.map((c) => c.id).filter((c): c is string => Boolean(c)));
    return {
      mode, teams: data.teams, competitions: data.competitions, teamIds, competitionIds, toggle,
      isFollowing: (kind, id) => (kind === 'team' ? teamIds : competitionIds).has(id),
    };
  }, [mode, data, toggle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFavorites(): FavoritesValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useFavorites must be used inside FavoritesProvider');
  return v;
}
