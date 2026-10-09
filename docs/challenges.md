# KICKSCOUT Challenges

Skill challenges players enter with a short video, judged against a published rubric, with
leaderboards, results, badges and scout discovery. This document is the gap analysis, the design
and the operating notes for the feature.

## 1. What already existed (gap analysis)

| Area | Before | Reused as | Gap closed here |
| --- | --- | --- | --- |
| `challenges` table | slug, bilingual title/description, skill, hashtag, dates, demo flag (3 demo rows) | the challenge row, extended in place | lifecycle status, difficulty, category, format, instructions, equipment, safety, recording rules, durations, attempts, timezone, visibility, featured, reward text, rubric pointer |
| `challenge_entries` | (challenge, video) pairs, no state | kept and still written, so old readers keep working | per-entry state, attempts, scores, reviews, appeals live in `challenge_submissions` and friends |
| Upload (`POST /v1/uploads`) | signed URL, quota, `challengeId` | the only way a challenge video is created | creates a submission in the same transaction, idempotency key, eligibility, attempt limits, consent and safety acknowledgements |
| Video pipeline + moderation | worker validates, transcodes, AI-moderates; nothing is public until `videos.status = 'published'` | the mandatory gate, untouched | a database trigger on `videos.status` queues `challenge.sync`; the submission follows the video. Challenges never publish anything themselves |
| Guardian (video safety agent, separate PR) | in progress | whatever sets `videos.status` | no second moderation pipeline. Any status the safety agent adds that is not `published`, `rejected`, `failed` or `deleted` keeps a submission in `pending_moderation` |
| Policy (`can()`) | `challenge.enter`, `challenge.manage` | extended | `challenge.judge`, `challenge.vote`, `challenge.scout_pick`, `challenge.h2h` |
| Notifications | in-app table, per-category preferences (`challenge.*` → category `challenge`) | delivery | idempotent ledger `challenge_notifications`, a daily cap for optional reminders |
| Audit (`audit_logs`, append-only) | every admin action | the challenge audit trail | `challenge_audit_logs` is a view over it |
| Play (PR #1) XP ledger `play_xp` | XP, levels, streaks | challenge XP lands in the same ledger, so there is one level | sources `challenge_entry`, `challenge_podium`, `challenge_award` |
| Worker maintenance (daily cron + wake) | the operations supervisor | challenge operations run inside it | lifecycle moves, rubric freeze, stuck-job detection, reminders, results |
| `ai_calls` | cost log for model calls | used if a model-backed agent is ever enabled | `challenge_agent_runs` records every challenge agent run (model or rules) |
| SEO (`/v1/sitemap`, `pageMetadata`) | profiles and videos | extended | indexable challenges in the sitemap, `GET /v1/seo/challenges/:slug`, noindex otherwise |

## 2. Data model (migration `0011_challenges.sql`)

Additive except two in-place changes: new columns on `challenges` and the `play_xp.source` check.

- `challenges` (+ columns), `challenge_rules`, `challenge_rubric_versions`
- `challenge_participations` (one per player per challenge), `challenge_submissions` (one per attempt, one video each)
- `challenge_submission_reviews` (every judge/verification decision), `challenge_scores` (one current score per submission, history kept by `superseded_at`), `challenge_score_components`
- `challenge_votes`, `challenge_leaderboard_snapshots`, `challenge_badges`, `user_challenge_badges`
- `challenge_appeals`, `challenge_notifications`, `challenge_judges`, `challenge_scout_picks`, `challenge_head_to_heads`, `challenge_agent_runs`
- view `challenge_audit_logs`

Database-enforced invariants (not just API checks):

- A submission can be `pending_judging` or `approved` only while its video is `published`.
- A submission can be `approved` only with a current confirmed score.
- A frozen rubric version cannot change, and a challenge cannot switch rubric once it has started.
- One vote per voter per submission; one open appeal per submission; one current score per submission; one submission per video; one participation per player per challenge; idempotency keys unique per user.

Rollback: `db/rollbacks/0011_challenges.down.sql` (tested in `apps/api/test/challenges-migration.test.ts`).

## 3. Submission states

```
pending_upload → processing → pending_moderation → pending_judging → approved
                     │               │                   │
                     ▼               ▼                   ▼
             failed_processing    rejected          disqualified
(any state) → withdrawn  (player withdraws, or the video is deleted)
```

The video decides the first half. `challenge.sync` maps `uploading → pending_upload`, `processing/analyzing → processing`,
`published → verification → pending_judging`, `rejected → rejected`, `failed → failed_processing`, `deleted → withdrawn`,
anything else → `pending_moderation`. Judges decide the second half.

## 4. Scoring

Each challenge has a versioned rubric frozen when the challenge starts. Methods:

- `measured`: a judge confirms an objective number (touches, time, hits) plus penalties defined in the rubric.
- `judged`: judges score each rubric criterion 0–10; the value is the weighted mean.

Community Favorite (eligible votes) and Scout Pick (verified scouts) are awards next to the leaderboard, never the ranking itself.
Rubrics can ask for two judges; values outside the rubric's tolerance go to an admin instead of being averaged.

No AI measurement ships. The Skill Scoring Agent checks a capability registry; every video-measurement capability is
`unvalidated`, so every submission goes to human judging and the player's own claimed number is shown to the judge as a
claim only. The Verification Agent checks only what the platform can actually observe (duration from the worker's probe,
upload time inside the window, byte-identical duplicates, the safety pipeline's football flag).

## 5. Agents

All agents are modules (pure logic in `packages/domain/src/challenges/`, I/O in `apps/worker/src/challenges/`), run by the
existing worker and maintenance cron, and write one `challenge_agent_runs` row per run: agent, version, provider/model (null
for rule-based agents), latency, outcome, confidence, cost, trace id.

| Agent | What it does now |
| --- | --- |
| Recommendation | ranks open challenges by difficulty ladder, the player's skills and history |
| Video Verification | observable requirement checks after the safety pipeline publishes the video |
| Skill Scoring | capability gate: routes to human judging (no validated model) |
| Anti-Fraud | duplicate videos across entrants, vote eligibility (account age, self-votes, blocks), vote bursts |
| SEO | indexability decision, title/description/canonical, sitemap entries |
| Operations | lifecycle transitions, rubric freeze, stuck submissions, judging backlog, failure spikes, ending-soon reminders, results |
| Notification | idempotent in-app notifications with preferences and a daily cap |

## 6. API

Public/player: `GET /v1/challenges` (legacy list), `GET /v1/challenges/hub`, `GET /v1/challenges/recommended`, `GET /v1/challenges/:slug`,
`GET /v1/challenges/:slug/entries|leaderboard|results`, `POST /v1/challenges/:slug/join`, `POST /v1/challenges/:slug/submissions`
(new clip), `POST /v1/challenges/:slug/entries` (a clip uploaded during the window), `GET /v1/me/challenges`,
`POST /v1/challenge-submissions/:id/withdraw|appeal`, `POST|DELETE /v1/challenge-submissions/:id/vote`,
`POST /v1/challenges/:slug/head-to-heads`, `POST /v1/challenge-head-to-heads/:id/accept|decline`, `POST /v1/challenges/:slug/scout-picks`.

Judges: `GET /v1/judge/challenges/queue`, `GET /v1/judge/challenge-submissions/:id`, `POST /v1/judge/challenge-submissions/:id/reviews`.

Admin: `GET/POST /v1/admin/challenges`, `POST /v1/admin/challenges/templates/install`, `GET /v1/admin/challenges/metrics`,
`GET/PATCH /v1/admin/challenges/:id`, `POST /v1/admin/challenges/:id/rubric|transition|recalculate`, `PUT /v1/admin/challenges/:id/judges`,
`GET /v1/admin/challenges/:id/fraud`, `GET /v1/admin/challenge-appeals`, `POST /v1/admin/challenge-appeals/:id/resolve`.

SEO: `GET /v1/seo/challenges/:slug`, challenges in `GET /v1/sitemap`.

## 6b. Web

- `/challenges`: hub (featured, picked for you, trending, ending soon, new, beginner, advanced freestyle, upcoming, results).
- `/challenges/:slug`: rules, how to film, safety, rubric, join, record/submit (goes to `/upload?slug=`), enter an existing clip,
  your entries (withdraw, appeal, share result), live/final leaderboard (overall or your country), votes, Scout Picks, results, invite link.
  Metadata comes from the SEO agent; anything it does not mark indexable is `noindex`.
- `/challenges/mine`: joined challenges, every entry and its state, XP, streak, badges, personal bests, head-to-heads, appeals.
- `/upload?challenge=&slug=`: the normal upload wizard plus the entry fields (own count, others in clip and their consent,
  safety acknowledgement), sent with an idempotency key so a retry never uses another attempt.
- `/judge`: blind queue (clip, rubric, automatic checks, flags; never the player). `/admin/challenges`: templates, drafts,
  publish/pause/close/publish results, judges, appeals, metrics and agent costs.

## 7. Safety and privacy rules

- Nothing about a submission is public until its video is `published` by the safety pipeline and it is approved by a judge.
- Leaderboards and entries reuse `discoverable()`: public video, public profile, active owner, no blocks. A minor's clip stays
  private until their guardian opens the profile, so it is judged but never listed.
- Only staff (admin/moderator with MFA) judge clips that are not public. Assigned outside judges see public clips only.
- Country leaderboards only use a country the player chose to show. There are no city leaderboards (no consented precise data).
- Head-to-head: mutual follows, no blocks, and adults and minors only within a guardian pair (the Play rule).
- Challenges that need a second person require the entrant to confirm that person's consent; advanced and expert challenges
  require a safety acknowledgement. Catalog copy never asks for stunts, heights, roads or private property.
- No cash prizes, paid entry, betting or odds. `reward` is free text that admins fill with non-cash recognition.

## 8. Not built (honest list)

- Automatic measurement (juggle counting, cone timing) from video: no validated model, so judges do it.
- Push and email notifications: the platform has no push channel and no production mailer yet; challenge notices are in-app.
- City leaderboards: no consented precise location data.
- Real staging: there is no staging environment; verification ran against a local Postgres and the local app.
