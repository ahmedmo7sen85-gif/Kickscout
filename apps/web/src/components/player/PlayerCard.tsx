'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { DemoBadge, VerifiedBadge } from '@/components/ui/Badge';
import { countryName, flagEmoji } from '@/lib/format';
import { useI18n } from '@/lib/i18n/provider';
import type { PlayerCard as PlayerCardData } from '@/lib/types';

export function Avatar({ src, name, size = 48 }: { src: string | null; name: string; size?: number }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((p) => p[0] ?? '').join('').toUpperCase();
  return src
    ? <img className="avatar" src={src} alt="" width={size} height={size} style={{ inlineSize: size, blockSize: size }} />
    : <span className="avatar avatar--initials" style={{ inlineSize: size, blockSize: size, fontSize: size * 0.38 }} aria-hidden="true">{initials || '·'}</span>;
}

/** Player summary. Shows real counts from the API only; no score or rating of any kind. */
export function PlayerCard({ player, children, footer }: { player: PlayerCardData; children?: ReactNode; footer?: ReactNode }) {
  const { t, locale, fmt, formatNumber } = useI18n();
  return (
    <article className="player-card">
      <Link href={`/u/${player.handle}`} className="player-card__main">
        <Avatar src={player.avatarUrl} name={player.displayName} />
        <div className="player-card__id">
          <p className="player-card__name">
            <span dir="auto">{player.displayName}</span>
            {player.verified ? <VerifiedBadge compact /> : null}
            {player.isDemo ? <DemoBadge /> : null}
          </p>
          <p className="player-card__handle">@{player.handle}</p>
        </div>
      </Link>
      <p className="player-card__facts">
        {player.position ? <span>{t.positions[player.position]}</span> : null}
        {player.country ? <span>{flagEmoji(player.country)} {countryName(player.country, locale)}</span> : null}
        {player.foot ? <span>{t.feet[player.foot]}</span> : null}
        {player.ageGroup ? <span>{t.ageBands[player.ageGroup]}</span> : null}
      </p>
      <p className="player-card__stats muted small">
        {fmt(t.common.followersCount, { n: formatNumber(player.followers) })} · {fmt(t.common.videosCount, { n: formatNumber(player.videos) })}
      </p>
      {player.topSkills.length ? (
        <ul className="chips" aria-label={t.profile.featuredSkills}>
          {player.topSkills.slice(0, 3).map((s) => <li key={s}><span className="chip chip--sm">{t.skills[s]}</span></li>)}
        </ul>
      ) : null}
      {children}
      {footer ? <div className="player-card__footer">{footer}</div> : null}
    </article>
  );
}
