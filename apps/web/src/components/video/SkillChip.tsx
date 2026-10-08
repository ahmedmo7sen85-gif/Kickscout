'use client';

import Link from 'next/link';
import { useI18n } from '@/lib/i18n/provider';
import type { SkillKey } from '@/lib/types';

export function SkillChip({ skill, href, count, active }: { skill: SkillKey; href?: string; count?: number; active?: boolean }) {
  const { t, formatNumber } = useI18n();
  const body = (
    <>
      {t.skills[skill]}
      {count !== undefined ? <span className="chip__count">{formatNumber(count)}</span> : null}
    </>
  );
  const cls = `chip${active ? ' is-active' : ''}`;
  return href ? <Link href={href} className={cls}>{body}</Link> : <span className={cls}>{body}</span>;
}

export function HashtagChip({ tag, href, count }: { tag: string; href?: string; count?: number }) {
  const { formatNumber } = useI18n();
  const body = <>#{tag}{count !== undefined ? <span className="chip__count">{formatNumber(count)}</span> : null}</>;
  return href ? <Link href={href} className="chip chip--hashtag" dir="auto">{body}</Link> : <span className="chip chip--hashtag" dir="auto">{body}</span>;
}
