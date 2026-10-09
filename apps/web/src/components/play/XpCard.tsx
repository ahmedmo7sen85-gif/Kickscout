'use client';

import { Icon } from '@/components/ui/Icon';
import { useI18n } from '@/lib/i18n/provider';
import type { PlayProfile } from '@/lib/types';

/** Level, progress to the next level, streak and today's XP. Private to the player. */
export function XpCard({ profile, compact }: { profile: PlayProfile; compact?: boolean }) {
  const { t, fmt } = useI18n();
  const span = profile.nextLevelXp - profile.levelStartXp;
  const top = span <= 0;
  const pct = top ? 100 : Math.round(((profile.xp - profile.levelStartXp) / span) * 100);
  return (
    <section className={`xp-card${compact ? ' xp-card--compact' : ''}`} aria-label={fmt(t.play.level, { n: profile.level })}>
      <div className="xp-card__level">
        <span className="xp-card__num">{profile.level}</span>
        <div>
          <div className="xp-card__title">{fmt(t.play.level, { n: profile.level })}</div>
          <div className="muted">{t.play.tiers[profile.tier]}</div>
        </div>
      </div>
      <div className="xp-card__bar-wrap">
        <div className="xp-card__bar" role="progressbar" aria-label={t.play.progressLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <span style={{ inlineSize: `${pct}%` }} />
        </div>
        <div className="row row--between xp-card__meta">
          <span>{top ? t.play.maxLevel : fmt(t.play.xpOf, { xp: profile.xp, next: profile.nextLevelXp })}</span>
          {profile.today.xp ? <span className="xp-card__today">{fmt(t.play.todayXp, { n: profile.today.xp })}</span> : null}
        </div>
      </div>
      <div className="xp-card__streak">
        <Icon name="spark" size={18} />
        {profile.streakDays ? fmt(t.play.streak, { n: profile.streakDays }) : t.play.noStreak}
      </div>
    </section>
  );
}
