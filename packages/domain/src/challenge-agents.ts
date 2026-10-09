/**
 * Rule-based logic of the challenge agents (recommendation, anti-fraud, SEO, notifications,
 * awards). Pure: the worker and API do the I/O and record each run in `challenge_agent_runs`.
 * None of these call a model; where a model could help later it must pass the same schemas.
 */
import type { ChallengeCategory, ChallengeDifficulty, ChallengePhase } from './challenge-rules.js';
import { CHALLENGE_DIFFICULTIES } from './challenge-rules.js';
import type { Bi } from './play.js';

/** Version stamped on every agent run; bump when an agent's rules change. */
export const CHALLENGE_AGENT_VERSION = '2026.10.1';

// ---------------------------------------------------------------- Recommendation Agent

export interface RecommendCandidate {
  id: string;
  difficulty: ChallengeDifficulty;
  category: ChallengeCategory;
  skillKey: string | null;
  endsAt: Date;
  participants: number;
}

export interface PlayerHistory {
  /** Highest difficulty with an approved entry, or null for none yet. */
  bestApprovedDifficulty: ChallengeDifficulty | null;
  /** Categories with an approved entry. */
  categories: readonly ChallengeCategory[];
  /** Skills on the player's own published clips. */
  skills: readonly string[];
  /** Challenges the player already joined (excluded). */
  joined: readonly string[];
}

/**
 * Ranks open challenges for a player: the next rung of the difficulty ladder first, then their own
 * skills, a category they have not tried, and deadlines that are soon but not missed. Popularity
 * only breaks ties, so it cannot crowd out fit.
 */
export function recommendChallenges(cands: readonly RecommendCandidate[], h: PlayerHistory, now: Date, limit = 6): { id: string; reasons: string[] }[] {
  const ladder = CHALLENGE_DIFFICULTIES as readonly ChallengeDifficulty[];
  const target = h.bestApprovedDifficulty ? Math.min(ladder.indexOf(h.bestApprovedDifficulty) + 1, ladder.length - 1) : 0;
  const joined = new Set(h.joined);
  return cands
    .filter((c) => !joined.has(c.id) && c.endsAt > now)
    .map((c) => {
      const reasons: string[] = [];
      let score = 0;
      const gap = Math.abs(ladder.indexOf(c.difficulty) - target);
      score += 30 - gap * 12;
      if (gap === 0) reasons.push('level');
      if (c.skillKey && h.skills.includes(c.skillKey)) { score += 15; reasons.push('skill'); }
      if (!h.categories.includes(c.category)) { score += 8; reasons.push('new_category'); }
      const hoursLeft = (c.endsAt.getTime() - now.getTime()) / 3_600_000;
      if (hoursLeft <= 72) { score += 6; reasons.push('ending_soon'); }
      score += Math.min(5, Math.log10(1 + c.participants) * 2);
      return { id: c.id, reasons, score };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map(({ id, reasons }) => ({ id, reasons }));
}

// ---------------------------------------------------------------- Anti-Fraud Agent

/** Votes each person may give per challenge. */
export const VOTES_PER_CHALLENGE = 3;
/** Accounts younger than this may vote, but their votes are set aside (kept for review, not counted). */
export const MIN_VOTER_ACCOUNT_AGE_MS = 72 * 3_600_000;

export type VoteDecision =
  | { allowed: false; code: string; reason: string }
  | { allowed: true; eligible: boolean; flag: string | null };

export function voteDecision(i: { isOwner: boolean; isGuardianOfOwner: boolean; blocked: boolean; votesUsed: number; voterAccountAgeMs: number; votingOpen: boolean }): VoteDecision {
  if (!i.votingOpen) return { allowed: false, code: 'VOTING_CLOSED', reason: 'voting is closed for this challenge' };
  if (i.isOwner || i.isGuardianOfOwner) return { allowed: false, code: 'OWN_ENTRY', reason: 'you cannot vote for your own entry' };
  if (i.blocked) return { allowed: false, code: 'NOT_FOUND', reason: 'entry not found' };
  if (i.votesUsed >= VOTES_PER_CHALLENGE) return { allowed: false, code: 'VOTES_USED', reason: `you have used your ${VOTES_PER_CHALLENGE} votes in this challenge` };
  if (i.voterAccountAgeMs < MIN_VOTER_ACCOUNT_AGE_MS) return { allowed: true, eligible: false, flag: 'new_account' };
  return { allowed: true, eligible: true, flag: null };
}

export interface VoteRow { submissionId: string; voterId: string; createdAt: Date; voterAccountAgeMs: number; eligible: boolean }

/**
 * Coordinated voting: many votes on one entry inside a short window, mostly from young accounts.
 * Returns the entries to send to an admin, with the evidence.
 */
export function detectVoteBursts(votes: readonly VoteRow[], opts = { windowMs: 10 * 60_000, minVotes: 8, youngShare: 0.5, youngMs: 14 * 86_400_000 }) {
  const bySubmission = new Map<string, VoteRow[]>();
  for (const v of votes) bySubmission.set(v.submissionId, [...(bySubmission.get(v.submissionId) ?? []), v]);
  const flagged: { submissionId: string; votes: number; youngAccounts: number; windowStart: string }[] = [];
  for (const [submissionId, rows] of bySubmission) {
    const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    let start = 0;
    for (let end = 0; end < sorted.length; end++) {
      while (sorted[end]!.createdAt.getTime() - sorted[start]!.createdAt.getTime() > opts.windowMs) start++;
      const win = sorted.slice(start, end + 1);
      const young = win.filter((v) => v.voterAccountAgeMs < opts.youngMs).length;
      if (win.length >= opts.minVotes && young / win.length >= opts.youngShare) {
        flagged.push({ submissionId, votes: win.length, youngAccounts: young, windowStart: sorted[start]!.createdAt.toISOString() });
        break;
      }
    }
  }
  return flagged;
}

// ---------------------------------------------------------------- SEO Agent

export interface SeoChallengeInput {
  phase: ChallengePhase;
  visibility: 'public' | 'unlisted';
  isTemplate: boolean;
  isDemo: boolean;
  title: Bi;
  description: Bi;
  instructions: Bi;
}

/**
 * Index only open, judging or completed public challenges with enough original copy to be useful.
 * Drafts, demos, unlisted, cancelled, archived and thin pages are noindex and stay out of the sitemap.
 */
export function challengeIndexable(c: SeoChallengeInput): { index: boolean; reason: string } {
  if (c.isTemplate || c.isDemo) return { index: false, reason: c.isDemo ? 'demo' : 'template' };
  if (c.visibility !== 'public') return { index: false, reason: 'unlisted' };
  if (!['open', 'judging', 'completed'].includes(c.phase)) return { index: false, reason: c.phase };
  const words = `${c.description.en} ${c.instructions.en}`.trim().split(/\s+/).filter(Boolean).length;
  if (words < 25) return { index: false, reason: 'thin' };
  return { index: true, reason: 'ok' };
}

/** Meta description: the challenge's own copy, trimmed on a word boundary. */
export function seoDescription(text: string, max = 155): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20))}…`;
}

// ---------------------------------------------------------------- Notification Agent

export const CHALLENGE_NOTICES = {
  'challenge.submission_received': 'essential',
  'challenge.submission_failed': 'essential',
  'challenge.submission_rejected': 'essential',
  'challenge.result': 'essential',
  'challenge.disqualified': 'essential',
  'challenge.appeal_update': 'essential',
  'challenge.personal_best': 'reward',
  'challenge.badge': 'reward',
  'challenge.winners': 'reward',
  'challenge.h2h_invite': 'reward',
  'challenge.h2h_result': 'reward',
  'challenge.ending_soon': 'optional',
  'challenge.new_match': 'optional',
} as const;
export type ChallengeNoticeKind = keyof typeof CHALLENGE_NOTICES;

/** Optional reminders (ending soon, new matching challenge) per person per day; the rest are not capped. */
export const OPTIONAL_NOTICES_PER_DAY = 2;

export function noticeAllowed(kind: ChallengeNoticeKind, optionalSentToday: number): boolean {
  return CHALLENGE_NOTICES[kind] !== 'optional' || optionalSentToday < OPTIONAL_NOTICES_PER_DAY;
}

// ---------------------------------------------------------------- awards and XP

/** XP in the shared Play ledger. Only approved entries earn it, once per challenge, so spam earns nothing. */
export const CHALLENGE_XP = { entry: 40, podium: [150, 100, 70] as const, award: 60 } as const;

/** ISO week key (YYYY-Www) in UTC. */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Consecutive ISO weeks with an approved entry, ending this week (or last week, while this one is open). */
export function weeklyStreak(approvedAt: readonly Date[], now: Date): number {
  const weeks = new Set(approvedAt.map(isoWeekKey));
  const cursor = new Date(now);
  if (!weeks.has(isoWeekKey(cursor))) cursor.setUTCDate(cursor.getUTCDate() - 7);
  let n = 0;
  while (weeks.has(isoWeekKey(cursor))) {
    n++;
    cursor.setUTCDate(cursor.getUTCDate() - 7);
  }
  return n;
}

/** Badges earned from a player's approved history (challenge-specific ones are awarded at results). */
export function historyBadges(h: { approved: number; categories: number; weeklyStreak: number }): string[] {
  const out: string[] = [];
  if (h.approved >= 1) out.push('first_entry');
  if (h.weeklyStreak >= 3) out.push('streak_3');
  if (h.categories >= 4) out.push('all_rounder');
  return out;
}

/** Head-to-head result from both players' best values; null when either has no approved entry or it is a tie. */
export function headToHeadWinner(direction: 'higher' | 'lower', a: { userId: string; value: number | null }, b: { userId: string; value: number | null }): { winner: string | null; decided: boolean } {
  if (a.value === null && b.value === null) return { winner: null, decided: false };
  if (a.value === null) return { winner: b.userId, decided: true };
  if (b.value === null) return { winner: a.userId, decided: true };
  if (a.value === b.value) return { winner: null, decided: true };
  const aWins = direction === 'higher' ? a.value > b.value : a.value < b.value;
  return { winner: aWins ? a.userId : b.userId, decided: true };
}
